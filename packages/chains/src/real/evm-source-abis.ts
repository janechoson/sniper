import { parseAbi, type Abi } from "viem";

// Nguồn, revision và checksum được lưu trong abi/evm-discovery-manifest.json.
// Chỉ surface discovery; không có ABI ký/gửi giao dịch.
export const evmSourceAbis: Record<string, Abi> = {
  "uniswap-v2": parseAbi([
    "event PairCreated(address indexed token0,address indexed token1,address pair,uint256 pairCount)",
  ]),
  pancakeswap: parseAbi([
    "event PairCreated(address indexed token0,address indexed token1,address pair,uint256 pairCount)",
  ]),
  "uniswap-v3": parseAbi([
    "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
  ]),
  "uniswap-v4": parseAbi([
    "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
  ]),
  "pancakeswap-infinity-cl": parseAbi([
    "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,address hooks,uint24 fee,bytes32 parameters,uint160 sqrtPriceX96,int24 tick)",
  ]),
  "pancakeswap-infinity-bin": parseAbi([
    "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,address hooks,uint24 fee,bytes32 parameters,uint24 activeId)",
  ]),
  "four-meme": parseAbi([
    "event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)",
    "event LiquidityAdded(address base,uint256 offers,address quote,uint256 funds)",
    "function _tokenInfos(address token) view returns ((address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status))",
  ]),
  openfour: parseAbi([
    "event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)",
    "event MigrateExecuted(uint256 indexed presetId,address indexed caller,address indexed token,address vault,address migrateModule,bytes8 migrateTagId,uint256 totalRaised,uint256 remainingForSale,bytes32 hookDataHash,uint8 migratedDataVersion,bytes encodedMigratedData)",
    "event PhaseTransition(address indexed token,uint8 from,uint8 to,address operator)",
    "function registry() view returns(address)",
    "function wrappedNative() view returns(address)",
  ]),
  flap: parseAbi([
    "event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)",
    "event TokenQuoteSet(address token,address quoteToken)",
    "event TokenMigratorSet(address token,uint8 migratorType)",
  ]),
  "pons-v2": parseAbi([
    "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
    "event LaunchSwept(address indexed token,uint256 quoteOut,uint256 tokenOut)",
    "event PoolGraduated(address indexed token,uint256 positionId,uint256 tokenAmount,uint256 pairTokenAmount)",
    "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  ]),
  bags: parseAbi([
    "event TokenCreated(address indexed token,address indexed curve,address indexed creator,address feeShare,address partner,bytes32 poolId,string name,string symbol,string metadataURI)",
    "function curveForToken(address token) view returns(address)",
  ]),
  doppler: parseAbi([
    "event Create(address asset,address indexed numeraire,address initializer,address poolOrHook)",
    "event Migrate(address indexed asset,address indexed pool)",
    "function getAssetData(address asset) view returns(address numeraire,address timelock,address governance,address liquidityMigrator,address poolInitializer,address pool)",
  ]),
  long: parseAbi([
    "event LaunchCreated(address indexed poolOrHook,address indexed asset,address indexed numeraire,address poolInitializer,address launcher,bytes32 tickerKey,uint48 deployedAt,uint48 reservedUntil,string normalizedTicker)",
  ]),
  "pools-trade": parseAbi([
    "event TokenLaunched(bytes32 indexed poolId,address indexed token,address indexed finalPositionRecipient,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key)",
  ]),
};

export const isEvmDiscoveryFamily = (family: string) => !!evmSourceAbis[family];
