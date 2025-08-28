import { ethers } from 'ethers';
import Big from 'big.js';

import { initOrderEngine, expRetry, log, OrderProcessor, OrderStatus, printOrder, sleep } from '@bronlabs/intents-sdk';
import BronClient from '@bronlabs/bron-sdk';


export class SolverProcessor extends OrderProcessor {
  constructor(config) {
    super();

    const provider = new ethers.JsonRpcProvider(config.rpcUrl);

    const wallet = new ethers.Wallet(config.solverPrivateKey, provider);

    this.orderEngine = initOrderEngine(
      config.orderEngineAddress,
      wallet
    );

    this.bronApi = new BronClient({
      apiKey: config.bronApiKey,
      workspaceId: config.bronWorkspaceId
    });

    this.bronAccountId = config.bronAccountId;

    log.info(`Initialized Solver`)
  }

  async process(orderId, status) {
    switch (Number(status)) {
      case OrderStatus.USER_INITIATED:
        return await this.solverReact(orderId);

      case OrderStatus.WAIT_FOR_SOLVER_TX:
        return await this.sendSolverTransaction(orderId);
    }
  }

  async solverReact(orderId) {
    const { user, status, baseParams, quoteParams, pricingParams, createdAt } = await this.orderEngine.getOrder(orderId);

    if (![OrderStatus.USER_INITIATED, OrderStatus.AUCTION_IN_PROGRESS].includes(Number(status))) return;

    log.info(`Reacting on order "${orderId}", status = ${status}, ${printOrder(baseParams, quoteParams, pricingParams)}`);

    if ((createdAt + pricingParams.auctionDuration) * 1000n < Date.now()) {
      log.info(`Auction expired for order ${orderId}`);
      return;
    }

    const { addresses: [{ address: solverBaseAddress }] } = await this.bronApi.addresses.getDepositAddresses({
      accountId: this.bronAccountId,
      networkId: baseParams.networkId,
      limit: '1'
    })

    if (!solverBaseAddress) {
      log.error(`No deposit address found for network ${baseParams.networkId}`);
      return;
    }

    let price = pricingParams.maxPrice_e18; // todo: replace with real logic

    log.info(`Placing price for order ${orderId}: ${new Big(price).div(Big(10).pow(18)).toString()}`);

    const tx = await this.orderEngine.solverReact(orderId, solverBaseAddress, price, { gasLimit: 500_000 });
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
        withdrawal                         = existing;
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
        const w    = await this.bronApi.transactions.getTransactionById(transactionId);
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
