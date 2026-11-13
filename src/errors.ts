// Custom errors (Solidity >= 0.8.4) from verified sources, so a revert reads as its name, not "custom error 0x...".
// From: OpenZeppelin 5 (ERC20, access control), Kinetiq's StakingManager facets and InstantUnstakePool, and
// aave-v3-origin's Errors library as deployed by HyperLend (all verified on Sourcify, HyperEVM); and smart accounts'
// and paymasters' errors met replaying ERC-4337 operations: ZeroDev Kernel, Alchemy's LightAccount and Modular
// Account v2, Bleap's cosigning module (verified on Sourcify), Pimlico's paymaster, a bridge's relaying paymaster
// (UnrecycledBundle), Solady's SafeTransferLib (TransferFromFailed), Ostium's price upkeep (NotInitiated), and
// NonAdminSelfCall and a Kernel execution hook's ModuleCallNotAllowed (OpenChain's signature database, from
// verified contracts).
import { decodeErrorResult, parseAbiItem, toFunctionSelector, type Abi, type Hex } from 'viem';

export const KNOWN_ERRORS = [
  'InvalidSignatureType()', 'BundlerNotAllowed(address)', 'UnrecycledBundle()', 'TransferFromFailed()', 'NotInitiated(uint256)', 'NonAdminSelfCall()', 'UserOpValidationFunctionReverted(bytes24,bytes)', 'ValidationFunctionMissing(bytes4)',
  'InvalidValidator()', 'InvalidNonce()', 'ModuleCallNotAllowed(address)', 'OnlyExecuteUserOp()', 'InvalidValidationType()', 'PermissionNotAlllowedForUserOp()', 'NotRootPermission()',
  'ERC20InsufficientAllowance(address,uint256,uint256)', 'ERC20InsufficientBalance(address,uint256,uint256)', 'ERC20InvalidReceiver(address)', 'ERC20InvalidSpender(address)',
  'ReentrancyGuardReentrantCall()', 'AccessControlUnauthorizedAccount(address,bytes32)', 'EnforcedPause()', 'AboveMaximum()',
  'BelowMinimum()', 'ContractPaused()', 'InsufficientTokenBalance()', 'InvalidAddress()',
  'InvalidAmount()', 'MustBeDivisibleBy1e10()', 'NotWhitelisted()', 'StakingIsPaused()',
  'TransferFailed()', 'ValidatorNotActive()', 'InsufficientNativeBalance()', 'InvalidWithdrawal()',
  'WithdrawalIsPaused()', 'InstantUnstakeNotEnabled()', 'InstantUnstakePoolNotSet()', 'InsufficientBufferLiquidity()',
  'OutputBelowMinimum()', 'NotMatured()', 'AmountExceedsUint64()', 'CallerNotPoolAdmin()',
  'CallerNotPoolOrEmergencyAdmin()', 'CallerNotRiskOrPoolAdmin()', 'CallerNotAssetListingOrPoolAdmin()', 'AddressesProviderNotRegistered()',
  'InvalidAddressesProviderId()', 'NotContract()', 'CallerNotPoolConfigurator()', 'CallerNotAToken()',
  'InvalidAddressesProvider()', 'InvalidFlashloanExecutorReturn()', 'ReserveAlreadyAdded()', 'NoMoreReservesAllowed()',
  'EModeCategoryReserved()', 'ReserveLiquidityNotZero()', 'FlashloanPremiumInvalid()', 'InvalidReserveParams()',
  'InvalidEmodeCategoryParams()', 'CallerMustBePool()', 'InvalidMintAmount()', 'InvalidBurnAmount()',
  'ReserveInactive()', 'ReserveFrozen()', 'ReservePaused()', 'BorrowingNotEnabled()',
  'NotEnoughAvailableUserBalance()', 'InvalidInterestRateModeSelected()', 'HealthFactorLowerThanLiquidationThreshold()', 'CollateralCannotCoverNewBorrow()',
  'NoDebtOfSelectedType()', 'NoExplicitAmountToRepayOnBehalf()', 'UnderlyingBalanceZero()', 'HealthFactorNotBelowThreshold()',
  'CollateralCannotBeLiquidated()', 'SpecifiedCurrencyNotBorrowedByUser()', 'InconsistentFlashloanParams()', 'BorrowCapExceeded()',
  'SupplyCapExceeded()', 'DebtCeilingExceeded()', 'UnderlyingClaimableRightsNotZero()', 'VariableDebtSupplyNotZero()',
  'LtvValidationFailed()', 'InconsistentEModeCategory()', 'PriceOracleSentinelCheckFailed()', 'AssetNotBorrowableInIsolation()',
  'ReserveAlreadyInitialized()', 'UserInIsolationModeOrLtvZero()', 'InvalidLtv()', 'InvalidLiquidationThreshold()',
  'InvalidLiquidationBonus()', 'InvalidDecimals()', 'InvalidReserveFactor()', 'InvalidBorrowCap()',
  'InvalidSupplyCap()', 'InvalidLiquidationProtocolFee()', 'InvalidDebtCeiling()', 'InvalidReserveIndex()',
  'AclAdminCannotBeZero()', 'InconsistentParamsLength()', 'ZeroAddressNotValid()', 'InvalidExpiration()',
  'InvalidSignature()', 'OperationNotSupported()', 'DebtCeilingNotZero()', 'AssetNotListed()',
  'InvalidOptimalUsageRatio()', 'UnderlyingCannotBeRescued()', 'AddressesProviderAlreadyAdded()', 'PoolAddressesDoNotMatch()',
  'SiloedBorrowingViolation()', 'ReserveDebtNotZero()', 'FlashloanDisabled()', 'InvalidMaxRate()',
  'WithdrawToAToken()', 'SupplyToAToken()', 'Slope2MustBeGteSlope1()', 'CallerNotRiskOrPoolOrEmergencyAdmin()',
  'LiquidationGraceSentinelCheckFailed()', 'InvalidGracePeriod()', 'InvalidFreezeState()', 'InvalidLtvzeroState()',
  'NotBorrowableInEMode()', 'CallerNotUmbrella()', 'ReserveNotInDeficit()', 'MustNotLeaveDust()',
  'UserCannotHaveDebt()', 'SelfLiquidation()', 'CallerNotPositionManager()', 'InvalidCollateralInEmode(address,uint256)',
  'InvalidDebtInEmode(address,uint256)', 'MustBeEmodeCollateral(address,uint256)',
];

/** What the most common ones mean for the person signing. */
const MEANING: Record<string, string> = {
  InvalidSignatureType: "the signature isn't of a type the account takes",
  BundlerNotAllowed: 'the paymaster only pays for operations its own bundlers submit',
  UnrecycledBundle: 'the paymaster only pays for bundles sent through its own contract, which relays them to the EntryPoint',
  TransferFromFailed: 'a token transfer from the account failed: too little balance or allowance',
  NonAdminSelfCall: 'the account only lets an admin key make calls to itself',
  ValidationFunctionMissing: 'the account has no validation installed for this call',
  InvalidValidator: "the validator the operation names isn't installed for this call",
  ModuleCallNotAllowed: "the hook the account's key was installed with doesn't let it call that module",
  ERC20InsufficientAllowance: 'the contract is not allowed to move that much of your token (approve it first)',
  ERC20InsufficientBalance: 'you do not hold enough of the token',
  BelowMinimum: 'the amount is below the minimum',
  AboveMaximum: 'the amount is above the maximum or the staking limit',
  MustBeDivisibleBy1e10: 'the HYPE amount must be a multiple of 0.00000001 HYPE (HyperCore uses 8 decimals)',
  StakingIsPaused: 'staking is paused',
  WithdrawalIsPaused: 'withdrawals are paused',
  ContractPaused: 'the contract is paused',
  NotWhitelisted: 'your address is not on the whitelist',
  InvalidWithdrawal: 'there is no claimable withdrawal with that ID (not ready yet, or already claimed)',
  InsufficientTokenBalance: 'you do not hold enough kHYPE',
  InsufficientBufferLiquidity: 'the instant-unstake buffer does not have enough HYPE',
  OutputBelowMinimum: 'you would receive less than your minimum',
  HealthFactorLowerThanLiquidationThreshold: 'it would leave your position below a health factor of 1 (liquidatable)',
  CollateralCannotCoverNewBorrow: 'your collateral cannot cover this borrow',
  NotEnoughAvailableUserBalance: 'you have not supplied that much',
  LtvValidationFailed: 'it would leave your borrowing above the allowed loan-to-value',
  BorrowCapExceeded: 'the market has reached its borrow cap',
  SupplyCapExceeded: 'the market has reached its supply cap',
  ReserveFrozen: 'this market is frozen',
  ReservePaused: 'this market is paused',
  ReserveInactive: 'this market is inactive',
  BorrowingNotEnabled: 'borrowing is not enabled for this asset',
  NoExplicitAmountToRepayOnBehalf: 'repaying for someone else needs an explicit amount, not "all"',
  UnderlyingBalanceZero: 'you have nothing supplied in this market',
  CallerNotPositionManager: 'the caller is not an approved position manager for that account',
};

let selectors: Map<string, string> | null = null;
/** "Name: meaning" for a known custom error, or null. */
export function knownError(data: Hex): string | null {
  if (!selectors) {
    selectors = new Map();
    for (const e of KNOWN_ERRORS) selectors.set(toFunctionSelector(`function ${e}`), e);
  }
  const sig = selectors.get(data.slice(0, 10).toLowerCase());
  if (!sig) return null;
  const name = sig.slice(0, sig.indexOf('('));
  let args = '';
  try {
    const r = decodeErrorResult({ abi: [parseAbiItem(`error ${sig}`)] as Abi, data });
    if (r.args?.length) args = `(${r.args.map(a => String(a)).join(', ')})`;
  } catch { /* name only */ }
  return MEANING[name] ? `${name}: ${MEANING[name]}` : `${name}${args}`;
}
