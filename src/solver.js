import { BigNumber, ethers } from 'ethers';

import { initNetworks, initOrderEngine, log, OrderProcessor, sleep } from '@bronlabs/intents-sdk';
import BronClient from '@bronlabs/bron-sdk';


export class SolverProcessor extends OrderProcessor {
  constructor(config) {
    super();

    const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);

    const wallet = new ethers.Wallet(config.solverPrivateKey, provider);

    this.solverAddress = wallet.address;

    this.orderEngine = initOrderEngine(
      config.orderEngineAddress,
      wallet
    );

    this.networks = initNetworks(config.networks, cfg => !!cfg.walletAddress && !!cfg.walletPrivateKey);

    this.solverWallets = Object.keys(this.networks).reduce((acc, networkName) => ({
      ...acc,
      [networkName]: {
        address: config.networks[networkName].walletAddress,
        privateKey: config.networks[networkName].walletPrivateKey
      }
    }), {});

    this.bronAccountId = config.bronAccountId;
    this.bronApi = new BronClient({
      apiKey: config.bronApiKey,
      workspaceId: config.bronWorkspaceId,
      baseUrl: config.bronApiUrl
    });

    log.info(`Initialized Solver with networks: ${Object.keys(this.networks).join(', ')}`)
  }

  async process(orderId, status) {
    log.info(`Processing OrderStatusChanged - Order ID: ${orderId}, Status: ${status}`);

    switch (status) {
      // USER_INITIATED
      case 1:
        return await this.solverReact(orderId);

      // WAIT_FOR_SOLVER_TX
      case 5:
        return await this.sendSolverTransaction(orderId);
    }
  }

  async solverReact(orderId) {
    const { user, status, baseParams, quoteParams, pricingParams, createdAt } = await this.orderEngine.getOrder(orderId);

    log.info(`Fetched details for order ${orderId}: status=${status}, base=${baseParams}, quote=${quoteParams}, pricing=${pricingParams}`);

    if (![1, 2].includes(status)) return; // USER_INITIATED or AUCTION_IN_PROGRESS

    const baseNetwork = this.networks[baseParams.networkId];
    if (!baseNetwork) {
      log.info(`Unsupported base network ${baseParams.networkId}`);
      return;
    }

    const quoteNetwork = this.networks[quoteParams.networkId];
    if (!quoteNetwork) {
      log.info(`Unsupported quote network ${quoteParams.networkId}`);
      return;
    }

    if (!this.solverWallets[baseParams.networkId]) {
      log.info(`Solver does not have a wallet for network ${quoteParams.networkId}`);
      return;
    }

    if ((parseInt(createdAt, 10) + parseInt(pricingParams.auctionDuration, 10)) * 1000 < Date.now()) {
      log.info(`Auction expired for order ${orderId}`);
      return;
    }

    /**
     * TODO:
     *   - check if solver supports these tokens
     *   - check if solver has enough funds in wallet to pay fees and transfer tokens
     *   - wait for target price on which solver will accept the order
     */

    log.info(`Solver reacting on order ${orderId}...`)

    const price = pricingParams.maxPrice_e18;

    const tx = await this.orderEngine.solverReact(orderId, this.solverWallets[baseParams.networkId].address, price, { gasLimit: 500000 });
    await tx.wait();
  }

  async sendSolverTransaction(orderId) {
    const { status, solver, baseParams, quoteParams, pricingParams } = await this.orderEngine.getOrder(orderId);

    log.info(`Fetched details for order ${orderId}: status=${status}, solver=${solver} base=${baseParams}, quote=${quoteParams}, pricing=${pricingParams}`);

    if (status !== 5) return; // WAIT_FOR_SOLVER_TX

    if (solver !== this.solverAddress) return;

    const baseNetwork  = this.networks[baseParams.networkId];
    const quoteNetwork = this.networks[quoteParams.networkId];

    const baseTokenDecimals  = await baseNetwork.getDecimals(baseParams.tokenAddress);
    const quoteTokenDecimals = await quoteNetwork.getDecimals(quoteParams.tokenAddress);

    const quoteAmount = !BigNumber.from(pricingParams.quoteAmount).isZero() ?
      BigNumber.from(pricingParams.quoteAmount) :
      BigNumber.from(pricingParams.baseAmount)
        .mul(BigNumber.from(pricingParams.price_e18))
        .div(BigNumber.from(10).pow(baseTokenDecimals + 18 - quoteTokenDecimals));

    // Resolve assetId (native vs token)
    const assetId = await this.resolveAssetId(quoteParams.tokenAddress, quoteParams.networkId);

    // Create withdrawal via Bron API
    const externalId = `${orderId}-solver`;
    let withdrawal;
    try {
      withdrawal = await this.bronApi.transactions.createTransaction({
        accountId: this.bronAccountId,
        externalId,
        transactionType: 'withdrawal',
        params: {
          amount: BigNumber.from(quoteAmount).toString(),
          assetId,
          toAddress: quoteParams.userAddress
        }
      });
    } catch (e) {
      if (e.message?.includes('already-exists')) {
        const { transactions: [existing] } = await this.bronApi.transactions.getTransactions({
          accountIds: [this.bronAccountId], externalId, limit: '1'
        });
        withdrawal = existing;
      } else {
        log.error(`[Critical]: Failed to create withdrawal for order ${orderId}:`, e);
        return;
      }
    }

    // Wait until blockchainTxId is available
    const txHash = await this.waitForBlockchainTx(withdrawal.transactionId, orderId);
    if (!txHash) return;

    log.info(`Sent transaction ${txHash}: ${BigNumber.from(quoteAmount).toString()} ${assetId} to ${quoteParams.userAddress}`);

    const tx = await this.orderEngine.setSolverTxOnQuoteNetwork(orderId, txHash, { gasLimit: 500000 });
    await tx.wait();
  }

  async resolveAssetId(tokenAddress, networkId) {
    if (tokenAddress === '0x0') {
      const { nativeAssetId } = await this.bronApi.assets.getNetworkById(networkId);
      return nativeAssetId;
    }
    const { assets: [asset] } = await this.bronApi.assets.getAssets({
      networkIds: [networkId],
      contractAddress: tokenAddress,
      limit: '1'
    });
    return asset.assetId;
  }

  async waitForBlockchainTx(transactionId, orderId) {
    for (let i = 0; i < 60; i++) {
      try {
        const w = await this.bronApi.transactions.getTransactionById(transactionId);
        const txId = w.extra?.blockchainDetails?.[0]?.blockchainTxId;
        if (txId) return txId;
        if (w.terminatedAt) {
          log.error(`[Critical]: Withdrawal terminated for order ${orderId} with status ${w.status}`);
          return null;
        }
      } catch (e) {
        log.error(`Error polling transaction ${transactionId} for order ${orderId}:`, e);
      }
      await sleep(2000);
    }
    log.error(`[Critical]: Timeout waiting for blockchain tx for order ${orderId}`);
    return null;
  }
}
