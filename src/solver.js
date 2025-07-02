import { BigNumber, ethers } from 'ethers';

import { initNetworks, initOrderEngine, log, OrderProcessor } from '@bronlabs/intents-sdk';


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

    log.info(`Initialized Solver with networks: ${Object.keys(this.networks).join(', ')}`)
  }

  async process(orderId, status) {
    log.info(`Processing OrderStatusChanged - Order ID: ${orderId}, Status: ${status}`);

    switch (status) {
      case 1:
        return await this.solverReact(orderId);
      case 4:
        return await this.sendSolverTransaction(orderId);
    }
  }

  async solverReact(orderId) {
    const { status, baseParams, quoteParams } = await this.orderEngine.orders(orderId);

    log.info(`Fetched details for order ${orderId}: ${status}, ${baseParams}, ${quoteParams}`);

    if (status !== 1) return;

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

    /**
     * TODO:
     *   - check if solver supports these tokens
     *   - check if solver has enough funds in wallet to pay fees and transfer tokens
     *   - wait for target price on which solver will accept the order
     */

    log.info(`Solver reacting on order ${orderId}...`)

    const tx = await this.orderEngine.solverReact(orderId, this.solverWallets[baseParams.networkId].address);
    await tx.wait();
  }

  async sendSolverTransaction(orderId) {
    const { status, solver, baseParams, quoteParams, pricingParams } = await this.orderEngine.orders(orderId);

    log.info(`Fetched details for order ${orderId}: ${status}, ${solver}, ${baseParams}, ${quoteParams}`);

    if (status !== 4) return;
    if (solver !== this.solverAddress) return;

    const baseNetwork  = this.networks[baseParams.networkId];
    const quoteNetwork = this.networks[quoteParams.networkId];

    const baseTokenDecimals  = await baseNetwork.getDecimals(baseParams.tokenAddress);
    const quoteTokenDecimals = await quoteNetwork.getDecimals(quoteParams.tokenAddress);

    const quoteAmount = BigNumber.from(pricingParams.amount)
      .mul(BigNumber.from(pricingParams.price_e18))
      .div(BigNumber.from(10).pow(baseTokenDecimals + 18 - quoteTokenDecimals));

    const txHash = await quoteNetwork.transfer(this.solverWallets[quoteParams.networkId].privateKey, quoteParams.recipientAddress, quoteAmount, quoteParams.tokenAddress);

    log.info(`Sent transaction ${txHash}: ${quoteAmount.toString()} ${quoteParams.tokenAddress} to ${quoteParams.recipientAddress}`);

    const tx = await this.orderEngine.setSolverTxOnQuoteChain(orderId, txHash);
    await tx.wait();
  }
}
