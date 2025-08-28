# Intents Solver Example

Minimal solver exaple that:
- Listens to OrderEngine events
- Reacts on-chain to user-initiated orders
- Sends the payout via Bron API and reports the tx hash on-chain

## Requirements
- Node >= 18
- Bron API key (JWK), workspace ID, account ID
- EVM RPC and solver private key

## Install & Run

```bash
npm install
npm start
```

## Flow
- Indexer emits OrderStatusChanged → solver handles:
  - USER_INITIATED (1): `solverReact` on-chain
  - WAIT_FOR_SOLVER_TX (5): create Bron `withdrawal`, poll for `blockchainTxId`, then `setSolverTxOnQuoteNetwork`
- Asset resolution via Bron API:
  - Native: `assets.getNetworkById(...).nativeAssetId`
  - Token: `assets.getAssets({ networkIds, contractAddress })`

Notes:
- On-chain calls require an ethers provider + wallet.
- Bron JS SDK is used for API operations only (no on-chain signing).
