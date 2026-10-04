import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {

  test('付款钱包读取不把默认账户当选择，也不把热当前账户当钱包锚点', () {
    final master = CitizenAccount(index: 0, accountId: _account(1), ss58Address: 'master',
      name: '账户0', createdAtMillis: BigInt.one, isActive: false);
    final child = CitizenAccount(index: 1, accountId: _account(2), ss58Address: 'child',
      name: '账户1', createdAtMillis: BigInt.one, isActive: true);
    final profile = CitizenWalletProfile(walletIndex: 0, walletName: '独立钱包',
      masterAccountId: master.accountId, origin: CitizenWalletOrigin.created,
      createdAtMillis: BigInt.one, activeAccountId: child.accountId, accounts: [master, child]);
    final rows = <CitizenWalletStateAccount>[
      CitizenWalletStateAccount(signMode: CitizenWalletSignMode.cold, walletIndex: 2, accountIndex: null,
        accountId: _account(3), ss58Address: 'cold', name: '冷钱包', createdAtMillis: BigInt.one, isDefault: true),
      for (final account in [master, child]) CitizenWalletStateAccount(signMode: CitizenWalletSignMode.hot,
        walletIndex: 0, accountIndex: account.index, accountId: account.accountId, ss58Address: account.ss58Address,
        name: account.name, createdAtMillis: account.createdAtMillis, isDefault: false),
    ];
    CitizenWalletState snapshot(int? index) => CitizenWalletState(revision: BigInt.one,
      hotProfile: profile, accounts: rows, initializationState: CitizenWalletInitializationState.ready,
      cleanupPending: false, activeWalletIndex: index);
    expect(snapshot(0).activeWalletAccount?.accountId, master.accountId);
    expect(snapshot(0).defaultAccount?.accountId, _account(3));
    expect(snapshot(0).hotProfile!.activeAccountId, child.accountId);
    expect(snapshot(2).activeWalletAccount?.accountId, _account(3));
    expect(snapshot(null).activeWalletAccount, isNull);
  });


  test('钱包公开模型复制列表与签名字节', () {
    final accounts = <CitizenAccount>[
      CitizenAccount(
        index: 0,
        accountId: _account(1),
        ss58Address: 'CitizenAddress',
        name: '主账户',
        createdAtMillis: BigInt.one,
        isActive: true,
      ),
    ];
    final profile = CitizenWalletProfile(
      walletIndex: 0,
      walletName: '独立钱包名',
      masterAccountId: _account(1),
      origin: CitizenWalletOrigin.created,
      createdAtMillis: BigInt.one,
      activeAccountId: _account(1),
      accounts: accounts,
    );
    accounts.clear();
    expect(profile.accounts, hasLength(1));
    expect(profile.walletName, '独立钱包名');
    expect(profile.accounts.single.name, '主账户');

    final source = Uint8List.fromList(List<int>.filled(64, 7));
    final signature = CitizenWalletSignature(
      accountId: _account(1),
      bytes: source,
    );
    source.fillRange(0, source.length, 0);
    expect(signature.bytes, everyElement(7));
  });

  test('统一钱包状态复制全局顺序并从首项派生默认账户', () {
    final accounts = <CitizenWalletStateAccount>[
      CitizenWalletStateAccount(
        signMode: CitizenWalletSignMode.cold,
        walletIndex: 1,
        accountIndex: null,
        accountId: _account(1),
        ss58Address: 'CitizenAddress',
        name: '冷账户',
        createdAtMillis: BigInt.one,
        isDefault: true,
      ),
    ];
    final state = CitizenWalletState(
      revision: BigInt.one,
      hotProfile: null,
      accounts: accounts,
      activeWalletIndex: 1,
      initializationState: CitizenWalletInitializationState.ready,
      cleanupPending: false,
    );
    accounts.clear();
    expect(state.accounts, hasLength(1));
    expect(state.activeWalletIndex, 1);
    expect(state.activeWalletAccount?.accountId, _account(1));
    expect(state.defaultAccount?.signMode, CitizenWalletSignMode.cold);
  });

  test('通用交易历史页只冻结安全execution投影', () {
    final records = <CitizenTransactionHistoryRecord>[
      CitizenTransactionHistoryRecord(
        executionId: '0x${'01' * 16}',
        sourceAccountId: _account(1),
        callDataHash: _account(2),
        transactionHash: _account(3),
        status: CitizenTransactionHistoryStatus.pending,
        block: null,
        execution: null,
        replacementHash: null,
        createdAtMillis: BigInt.one,
        updatedAtMillis: BigInt.one,
        poolRejectionReason: null,
      ),
    ];
    final history = CitizenTransactionHistoryPage(
      revision: BigInt.one,
      records: records,
      nextBeforeExecutionId: null,
    );
    records.clear();
    expect(
      history.records.single.status,
      CitizenTransactionHistoryStatus.pending,
    );
    expect(() => history.records.clear(), throwsUnsupportedError);
  });

  test('通用链字节模型复制header、body、runtime和显式状态', () {
    final block = CitizenBlockRef(
      hash: _account(3),
      number: BigInt.one,
      finality: CitizenBlockFinality.finalized,
    );
    final bytes = Uint8List.fromList(<int>[1, 2]);
    final header = CitizenBlockHeader(
      block: block,
      parentHash: _account(1),
      stateRoot: _account(2),
      extrinsicsRoot: _account(3),
      digest: bytes,
    );
    final body = CitizenBlockBody(block: block, extrinsics: <Uint8List>[bytes]);
    final runtime = CitizenRuntimeContext(
      block: block,
      specVersion: 1,
      transactionVersion: 1,
      metadata: bytes,
    );
    final state = CitizenChainState(
      formatVersion: 1,
      finalized: block,
      database: bytes,
    );
    bytes.fillRange(0, bytes.length, 0);
    expect(header.digest, <int>[1, 2]);
    expect(body.extrinsics.single, <int>[1, 2]);
    expect(runtime.metadata, <int>[1, 2]);
    expect(state.database, <int>[1, 2]);
    expect(() => body.extrinsics.single[0] = 0, throwsUnsupportedError);
  });

  test('通用交易准备与执行模型复制并冻结所有公开字节', () {
    final source = Uint8List.fromList(List<int>.filled(32, 1));
    final callHash = Uint8List.fromList(List<int>.filled(32, 2));
    final transactionHash = Uint8List.fromList(List<int>.filled(32, 3));
    final replacementHash = Uint8List.fromList(List<int>.filled(32, 4));
    final prepared = CitizenPreparedTransaction(
      preparationId: '0x${'01' * 16}',
      sourceAccountId: source,
      callDataHash: callHash,
      bestBlock: CitizenBlockRef(
        hash: _account(5),
        number: BigInt.one,
        finality: CitizenBlockFinality.best,
      ),
      runtimeSpecNumber: 1,
      transactionFormatNumber: 1,
      nonce: BigInt.zero,
    );
    final completed = CitizenTransactionExecutionCompleted(
      executionId: '0x${'02' * 16}',
      sourceAccountId: source,
      callDataHash: callHash,
      transactionHash: transactionHash,
      resolution: CitizenTransactionResolution.poolRejected,
      execution: null,
      poolRejectionReason: 'usurped',
      replacementHash: replacementHash,
    );
    source.fillRange(0, source.length, 0);
    callHash.fillRange(0, callHash.length, 0);
    transactionHash.fillRange(0, transactionHash.length, 0);
    replacementHash.fillRange(0, replacementHash.length, 0);
    expect(prepared.sourceAccountId, everyElement(1));
    expect(prepared.callDataHash, everyElement(2));
    expect(completed.transactionHash, everyElement(3));
    expect(completed.replacementHash, everyElement(4));
    expect(() => prepared.sourceAccountId[0] = 9, throwsUnsupportedError);
    expect(() => completed.callDataHash[0] = 9, throwsUnsupportedError);
    expect(() => completed.transactionHash[0] = 9, throwsUnsupportedError);
    expect(() => completed.replacementHash![0] = 9, throwsUnsupportedError);
  });
}

String _account(int byte) =>
    '0x${List<String>.filled(32, byte.toRadixString(16).padLeft(2, '0')).join()}';
