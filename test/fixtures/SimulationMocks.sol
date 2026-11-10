// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// Contracts for test/simulation-probe.test.ts, run in an in-process EVM behind a fake JSON-RPC node.

interface IERC1271 { function isValidSignature(bytes32, bytes calldata) external view returns (bytes4); }
interface IERC721Receiver { function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4); }

/// ERC-20 that is also WETH-like (deposit / withdraw native). It emits Transfer but, like some real tokens, no
/// Approval event, so simulators must read allowances rather than rely on events.
contract Token {
    event Transfer(address indexed from, address indexed to, uint256 value);
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory s, uint8 d) { symbol = s; decimals = d; }
    function mint(address to, uint256 v) external { balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function approve(address spender, uint256 v) external returns (bool) { allowance[msg.sender][spender] = v; return true; }
    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[from][msg.sender] = a - v; }
        _move(from, to, v);
        return true;
    }
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 v) external { require(balanceOf[msg.sender] >= v, "balance"); balanceOf[msg.sender] -= v; payable(msg.sender).transfer(v); }
    function _move(address from, address to, uint256 v) internal { require(balanceOf[from] >= v, "balance"); balanceOf[from] -= v; balanceOf[to] += v; emit Transfer(from, to, v); }
}

/// Pulls an asset and credits shares in itself (the target is the share token, so it's named by the call).
contract Vault is Token {
    Token public immutable asset;
    constructor(Token a) Token("vUSD", 6) { asset = a; }
    function deposit(uint256 amount) external { asset.transferFrom(msg.sender, address(this), amount); balanceOf[msg.sender] += amount; emit Transfer(address(0), msg.sender, amount); }
}

/// Aave-like: supply mints a receipt token the calldata doesn't mention.
contract Pool {
    Token public immutable asset;
    Token public immutable receipt;
    constructor(Token a, Token r) { asset = a; receipt = r; }
    function supply(uint256 amount) external { asset.transferFrom(msg.sender, address(this), amount); receipt.mint(msg.sender, amount); }
}

contract NFT {
    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(address => uint256) public balanceOf;

    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x80ac58cd || id == 0x01ffc9a7; }
    function mint(address to, uint256 id) external { ownerOf[id] = to; balanceOf[to]++; }
    /// Sells token `id` for 1 ether, minting it safely (a recipient with code is asked first).
    function buy(uint256 id) external payable {
        require(msg.value == 1 ether, "price");
        require(ownerOf[id] == address(0), "sold");
        ownerOf[id] = msg.sender;
        balanceOf[msg.sender]++;
        emit Transfer(address(0), msg.sender, id);
        if (msg.sender.code.length > 0) require(IERC721Receiver(msg.sender).onERC721Received(msg.sender, address(0), id, "") == 0x150b7a02, "receiver");
    }
    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && (msg.sender == from || isApprovedForAll[from][msg.sender] || getApproved[id] == msg.sender), "auth");
        ownerOf[id] = to;
        balanceOf[from]--;
        balanceOf[to]++;
        getApproved[id] = address(0);
        emit Transfer(from, to, id);
    }
    function approve(address spender, uint256 id) external { require(ownerOf[id] == msg.sender, "owner"); getApproved[id] = spender; }
    function setApprovalForAll(address operator, bool approved) external { isApprovedForAll[msg.sender][operator] = approved; }
}

/// Permit2's allowance layout and signature rule: ecrecover for accounts without code, ERC-1271 for the rest.
contract Permit2Like {
    event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce);
    struct Allowance { uint160 amount; uint48 expiration; uint48 nonce; }
    mapping(address => mapping(address => mapping(address => Allowance))) public allowance;

    function permit(address owner, address token, address spender, uint160 amount, uint48 expiration, bytes calldata sig) external {
        bytes32 h = keccak256(abi.encode(owner, token, spender, amount, expiration));
        if (owner.code.length == 0) {
            require(sig.length == 65, "sig");
            require(ecrecover(h, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64])) == owner, "sig");
        } else {
            require(IERC1271(owner).isValidSignature(h, sig) == 0x1626ba7e, "1271");
        }
        uint48 nonce = allowance[owner][token][spender].nonce;
        allowance[owner][token][spender] = Allowance(amount, expiration, nonce + 1);
        emit Permit(owner, token, spender, amount, expiration, nonce);
    }
}

/// A router that records the caller's signed Permit2 allowance for itself (the "along the way" pattern).
contract Router {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    function permitSelf(address token, uint160 amount, uint48 expiration, bytes calldata sig) external {
        Permit2Like(PERMIT2).permit(msg.sender, token, address(this), amount, expiration, sig);
    }
}

/// Only accounts without code may claim.
contract EoaOnly {
    Token public immutable token;
    constructor(Token t) { token = t; }
    function claim() external { require(msg.sender.code.length == 0, "EOA only"); token.mint(msg.sender, 1e6); }
}

contract Reverter {
    function fail() external pure { revert("nope"); }
}

/// Balances are shares × 10/3, as with share-based tokens: the Transfer event states the amount asked for, but the
/// balance moves by what the shares are worth (101 asked → 30 shares → 100 moved).
contract SharesToken {
    event Transfer(address indexed from, address indexed to, uint256 value);
    mapping(address => uint256) public shares;
    function decimals() external pure returns (uint8) { return 6; }
    function symbol() external pure returns (string memory) { return "stUSD"; }
    function balanceOf(address a) external view returns (uint256) { return shares[a] * 10 / 3; }
    function mintShares(address to, uint256 s) external { shares[to] += s; }
    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 s = amount * 3 / 10;
        shares[msg.sender] -= s;
        shares[to] += s;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// Reads a chain-specific precompile at 0x…0800 (HyperEVM's HyperCore reads live there).
contract CoreReader {
    function read(uint32 x) external view returns (uint256) {
        (bool ok, bytes memory r) = address(0x0000000000000000000000000000000000000800).staticcall(abi.encode(x));
        require(ok && r.length == 32, "precompile");
        return abi.decode(r, (uint256));
    }
}

/// A minimal smart-account implementation for EIP-7702: an account delegated to it runs execute() as itself.
contract Executor {
    function execute(address target, bytes calldata data) external payable {
        (bool ok, bytes memory r) = target.call{value: msg.value}(data);
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }
}

/// Each hop names the next in its storage, as proxies, registries and diamonds do, so a simulator that fetches
/// state on demand learns one link per round unless it has seen them before.
contract Hop {
    Hop public immutable next;
    uint256 public value;
    constructor(Hop n, uint256 v) { next = n; value = v; }
    function total() external view returns (uint256) { return value + (address(next) == address(0) ? 0 : next.total()); }
}

/// HyperEVM's CoreWriter: emits each action for HyperCore to pick up after the block.
contract CoreWriterLike {
    event RawAction(address indexed user, bytes data);
    function sendRawAction(bytes calldata data) external { emit RawAction(msg.sender, data); }
}

/// A contract that sends HyperCore actions for its own HyperCore account, as vaults and strategies do.
contract CoreSender {
    function act(bytes calldata data) external { CoreWriterLike(0x3333333333333333333333333333333333333333).sendRawAction(data); }
}

/// Checkpoints a recent block hash, as L2 bridges and randomness beacons do: reverts when BLOCKHASH gives nothing.
contract BlockHashReader {
    error L1BlockHashNotAvailable();
    function checkpoint(uint256 n) external view returns (bytes32 h) {
        h = blockhash(n);
        if (h == 0) revert L1BlockHashNotAvailable();
    }
}

/// ERC-4337 (EntryPoint v0.7): an account whose owner signs the operation's hash (eth_sign form), and a paymaster
/// that charges in a token after the calls (postOp).
struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }
contract Account4337 {
    address public owner;
    address public entryPoint;
    constructor(address o, address ep) { owner = o; entryPoint = ep; }
    function validateUserOp(PackedUserOperation calldata op, bytes32 hash, uint256 missing) external returns (uint256) {
        require(msg.sender == entryPoint, "entrypoint");
        if (missing > 0) { (bool paid, ) = payable(msg.sender).call{value: missing}(""); paid; }
        bytes calldata sig = op.signature;
        if (sig.length != 65) return 1;
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        return ecrecover(h, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64])) == owner ? 0 : 1;
    }
    function execute(address to, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, "entrypoint");
        (bool ok, bytes memory r) = to.call{value: value}(data);
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }
    receive() external payable {}
}
contract TokenPaymaster {
    address public entryPoint;
    Token public token;
    constructor(address ep, Token t) { entryPoint = ep; token = t; }
    function validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256) external view returns (bytes memory, uint256) {
        require(msg.sender == entryPoint, "entrypoint");
        return (abi.encode(op.sender), 0);
    }
    /// 1 token base unit per 10^9 wei of gas cost, plus one.
    function postOp(uint8, bytes calldata context, uint256 actualGasCost, uint256) external {
        require(msg.sender == entryPoint, "entrypoint");
        token.transferFrom(abi.decode(context, (address)), address(this), actualGasCost / 1e9 + 1);
    }
}
/// A contract that works by the transaction's priority fee (tx.gasprice above the base fee), as a pool taxing
/// swaps by it does: here it only runs for a tip of at least `atLeast`.
contract TipReader {
    function requireTip(uint256 atLeast) external view { require(tx.gasprice >= block.basefee + atLeast, "tip"); }
}
/// A paymaster that only pays for operations its own bundler sends (tx.origin), refusing others as some do.
contract BundlerPaymaster {
    error BundlerNotAllowed(address bundler);
    address public entryPoint;
    address public bundler;
    constructor(address ep, address b) { entryPoint = ep; bundler = b; }
    function validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256) external view returns (bytes memory, uint256) {
        require(msg.sender == entryPoint, "entrypoint");
        if (tx.origin != bundler) revert BundlerNotAllowed(tx.origin);
        return ("", 0);
    }
    function postOp(uint8, bytes calldata, uint256, uint256) external {}
}
/// The same account for EntryPoint v0.6, whose operations aren't packed.
struct UserOperationV06 { address sender; uint256 nonce; bytes initCode; bytes callData; uint256 callGasLimit; uint256 verificationGasLimit; uint256 preVerificationGas; uint256 maxFeePerGas; uint256 maxPriorityFeePerGas; bytes paymasterAndData; bytes signature; }
contract Account4337V06 {
    address public owner;
    address public entryPoint;
    constructor(address o, address ep) { owner = o; entryPoint = ep; }
    function validateUserOp(UserOperationV06 calldata op, bytes32 hash, uint256 missing) external returns (uint256) {
        require(msg.sender == entryPoint, "entrypoint");
        if (missing > 0) { (bool paid, ) = payable(msg.sender).call{value: missing}(""); paid; }
        bytes calldata sig = op.signature;
        if (sig.length != 65) return 1;
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        return ecrecover(h, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64])) == owner ? 0 : 1;
    }
    function execute(address to, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, "entrypoint");
        (bool ok, bytes memory r) = to.call{value: value}(data);
        if (!ok) assembly { revert(add(r, 32), mload(r)) }
    }
    receive() external payable {}
}

/// For call traces: one call that makes a call of each kind, one of which emits an event and then fails (caught).
contract TraceTarget {
    event Step(uint256 n);
    uint256 public counter;
    function run(Token token, address to, address noisy, address lib) external payable returns (uint256) {
        emit Step(1);
        token.transfer(to, 5);
        (bool failed, ) = noisy.call(abi.encodeWithSignature("fail()"));
        require(!failed, "expected to fail");
        (bool bumped, ) = lib.delegatecall(abi.encodeWithSignature("bump()"));
        require(bumped, "bump");
        uint256 balance = token.balanceOf(to);
        if (msg.value > 0) { (bool sent, ) = to.call{value: msg.value}(""); require(sent, "send"); }
        new Reverter();
        emit Step(3);
        return balance;
    }
}
/// Run by delegatecall: it writes the caller's storage and its event comes from the caller's address.
contract TraceLib {
    event Step(uint256 n);
    uint256 public counter;
    function bump() external payable { counter += 1; emit Step(2); }
}
/// Emits an event, then fails: the event is undone with the call.
contract Noisy {
    event Step(uint256 n);
    function fail() external { emit Step(99); revert("after an event"); }
}
