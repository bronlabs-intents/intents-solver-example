export const loadConfig = () => ({
  rpcUrl: process.env.INDEXER_ETH_RPC_URL,
  orderEngineAddress: process.env.ORDER_ENGINE_ADDRESS,
  solverPrivateKey: process.env.SOLVER_PRIVATE_KEY,

  // Bron SDK
  bronApiUrl: process.env.BRON_API_URL || 'https://api.bron.org',
  bronApiKey: process.env.BRON_API_KEY,
  bronWorkspaceId: process.env.BRON_WORKSPACE_ID,
  bronAccountId: process.env.BRON_ACCOUNT_ID,

  startBlockOffset: 1800, // ~ 1 hour
  pollingInterval: 1500,
  retryDelay: 5000,
  maxRetries: 2,

  networks: {
    testETH: {
      rpcUrl: process.env.TEST_ETH_RPC_URL,
      walletAddress: process.env.TEST_ETH_WALLET_ADDRESS,
      walletPrivateKey: process.env.TEST_ETH_PRIVATE_KEY
    },
    testTRX: {
      rpcUrl: process.env.TEST_TRX_RPC_URL,
      walletAddress: process.env.TEST_TRX_WALLET_ADDRESS,
      walletPrivateKey: process.env.TEST_TRX_PRIVATE_KEY
    },
    testSOL: {
      rpcUrl: process.env.TEST_SOL_RPC_URL,
      walletAddress: process.env.TEST_SOL_WALLET_ADDRESS,
      walletPrivateKey: process.env.TEST_SOL_PRIVATE_KEY
    },
    ETH: {
      rpcUrl: process.env.ETH_RPC_URL
    },
    TRX: {
      rpcUrl: process.env.TRX_RPC_URL
    },
    SOL: {
      rpcUrl: process.env.SOL_RPC_URL
    }
  }
});
