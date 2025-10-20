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

    try {
      const tx = await this.orderEngine.solverReact(orderId, solverBaseAddress, price, { gasLimit: 500_000 });
      await tx.wait();
    } catch (e) {
      log.error(`Failed to place price for order ${orderId}`, e); // skip errors here: maybe it's too late or price is too low
    }
  }

  async sendSolverTransaction(orderId) {
    const { status, solver, baseParams, quoteParams, pricingParams } = await this.orderEngine.getOrder(orderId);

    if (status !== BigInt(OrderStatus.WAIT_FOR_SOLVER_TX)) return;
    if (solver !== this.solverAddress) return;

    log.info(`Sending transaction for order "${orderId}", status = ${status}, ${printOrder(baseParams, quoteParams, pricingParams)}`);

    const baseToken  = await this.getTokenInfo(baseParams.tokenAddress, baseParams.networkId);
    const quoteToken = await this.getTokenInfo(quoteParams.tokenAddress, quoteParams.networkId);

    const quoteAmountUnits = pricingParams.quoteAmount ||
      (pricingParams.baseAmount * pricingParams.price_e18 / (10n ** BigInt(baseToken.decimals + 18 - quoteToken.decimals)));

    // quote amount in human format 123.45
    const quoteAmount = Big(quoteAmountUnits).div(Big(10).pow(quoteToken.decimals)).toFixed(quoteToken.decimals);

    log.info(`Sending: ${quoteAmount} ${quoteToken.assetId} to ${quoteParams.userAddress}...`);

    let withdrawal;

    try {
      withdrawal = await this.bronApi.transactions.createTransaction({
        accountId: this.bronAccountId,
        externalId: `${orderId}-solver`,
        transactionType: 'withdrawal',
        params: {
          amount: quoteAmount,
          assetId: quoteToken.assetId,
          toAddress: quoteParams.userAddress
        },
      });
    } catch (e) {
      if (e.message.includes('"error":"already-exists"')) {
        log.warn(`Withdrawal already exists for order ${orderId}`);

        const { transactions: [existing] } = await this.bronApi.transactions.getTransactions({
          accountIds: [this.bronAccountId],
          externalId: `${orderId}-solver`,
          limit: '1'
        });

        withdrawal = existing;
      } else {
        log.error(`[Critical Alert]: Solver transaction is not created for order ${orderId}:`, e);

        setTimeout(() => {
          this.delayedQueue.add({ orderId, status });
        }, 15000);

        return;
      }
    }

    log.info(`Sent transaction ${withdrawal.transactionId}: ${quoteAmount} ${quoteToken.assetId} to ${quoteParams.userAddress}`);

    // Wait until the transaction will be signed and broadcasted
    this.asyncWaitingForBlockchainTxHash(orderId, withdrawal).catch(error => {
      log.error(`[Critical Alert]: Error waiting for blockchain tx hash for order ${orderId}:`, error);
    });
  }

  async asyncWaitingForBlockchainTxHash(orderId, withdrawal) {
    await sleep(1000);

    try {
      withdrawal = await this.bronApi.transactions.getTransactionById(withdrawal.transactionId);
    } catch (e) {
      log.error(`Error getting transaction by id for order ${orderId}:`, e);
    }

    const blockchainTxId = withdrawal.extra.blockchainDetails?.[0]?.blockchainTxId;

    if (blockchainTxId && withdrawal.status === 'completed') {
      return await expRetry(async () => {
        log.info(`Sending setSolverTxOnQuoteNetwork '${blockchainTxId}' for order ${orderId}`);

        const tx = await this.orderEngine.setSolverTxOnQuoteNetwork(orderId, blockchainTxId, { gasLimit: 1_000_000 });
        return await tx.wait();
      });
    }

    if (withdrawal.terminatedAt) {
      log.error(`[Critical Alert]: Intents withdrawal terminated with status ${withdrawal.status} for order ${orderId}`);
      return;
    }

    log.info(`Waiting for withdrawal transaction '${withdrawal.transactionId}' (${withdrawal.status}) for order ${orderId} to be signed and broadcasted...`)

    setTimeout(() => {
      this.asyncWaitingForBlockchainTxHash(orderId, withdrawal).catch(error => {
        log.error(`[Critical Alert]: Error waiting for blockchain tx hash for order ${orderId}:`, error);
      });
    }, 2000);
  }

  async getTokenInfo(tokenAddress, networkId) {
    if (tokenAddress === '0x0') { // Native asset
      const { nativeAssetId } = await this.bronApi.assets.getNetworkById(networkId);
      const { decimals }      = await this.bronApi.assets.getAssetById(nativeAssetId);

      return {
        decimals: parseInt(decimals, 10),
        assetId: nativeAssetId
      };
    } else {
      const { assets: [asset] } = await this.bronApi.assets.getAssets({
        networkIds: [networkId],
        contractAddress: tokenAddress,
        limit: '1'
      });

      return {
        decimals: parseInt(asset.decimals, 10),
        assetId: asset.assetId
      };
    }
  }
}
