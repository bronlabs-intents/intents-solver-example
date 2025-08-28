export const loadConfig = () => ({
  rpcUrl: process.env.INDEXER_ETH_RPC_URL,
  orderEngineAddress: process.env.ORDER_ENGINE_ADDRESS,
  solverPrivateKey: process.env.SOLVER_PRIVATE_KEY,

  // Bron SDK
  bronApiKey: process.env.BRON_API_KEY,
  bronWorkspaceId: process.env.BRON_WORKSPACE_ID,
  bronAccountId: process.env.BRON_ACCOUNT_ID,

  startBlockOffset: 5000,
  pollingInterval: 1500,
  retryDelay: 5000,
  maxRetries: 5
});
