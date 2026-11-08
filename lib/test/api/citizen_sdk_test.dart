// 主包测试使用声明的dev_dependencies。
// ignore_for_file: depend_on_referenced_packages
import 'dart:async';
import 'dart:typed_data';

import 'package:citizen_sdk/citizen_sdk.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('外链 ERC-20', _erc20Tests);

  test('请求取消保留真实终态，不把取消接纳当完成', () async {
    final complete = Completer<int>();
    var finished = false, cancelled = 0;
    final operation = CitizenSdkOperation(
      operationId: '73',
      result: complete.future,
      cancel: () async {
        cancelled++;
        return true;
      },
    );
    unawaited(
      operation.result.then((_) {
        finished = true;
      }),
    );
    expect(await operation.cancel(), isTrue);
    expect(cancelled, 1);
    expect(finished, isFalse);
    expect(operation.operationId, '73');
    complete.complete(19);
    expect(await operation.result, 19);
  });
  test('拒绝取消不覆盖真实错误对象', () async {
    final failure = CitizenSdkException(
      code: CitizenSdkErrorCode.integrity,
      message: 'fixed',
      stage: CitizenSdkFailureStage.verification,
    );
    final complete = Completer<void>();
    final operation = CitizenSdkOperation(
      operationId: '74',
      result: complete.future,
      cancel: () async => false,
    );
    final settled = expectLater(operation.result, throwsA(same(failure)));
    expect(await operation.cancel(), isFalse);
    complete.completeError(failure);
    await settled;
  });
}


const _erc20Sender = '0x1111111111111111111111111111111111111111';
const _erc20Token = '0x2222222222222222222222222222222222222222';
const _erc20Recipient = '0x3333333333333333333333333333333333333333';
const _erc20Txid =
    '0x4444444444444444444444444444444444444444444444444444444444444444';
const _erc20Block =
    '0x5555555555555555555555555555555555555555555555555555555555555555';
const _erc20Input =
    '0xa9059cbb'
    '0000000000000000000000003333333333333333333333333333333333333333'
    '0000000000000000000000000000000000000000000000000000000000000007';

void _erc20Tests() {
  test('精确换算最小单位并限制精度范围', () {
    expect(scaleTokenUnits(BigInt.from(10), 6), BigInt.from(10000000));
    expect(
      scaleTokenUnits(BigInt.from(1000), 18),
      BigInt.parse('1000000000000000000000'),
    );
    expect(scaleTokenUnits(BigInt.one, 0), BigInt.one);
    expect(scaleTokenUnits(BigInt.one, 255).toString(), '1${'0' * 255}');
    expect(() => scaleTokenUnits(BigInt.one, -1), throwsRangeError);
    expect(() => scaleTokenUnits(BigInt.one, 256), throwsRangeError);
    expect(() => scaleTokenUnits(-BigInt.one, 6), throwsArgumentError);
  });

  test('编码 68 字节，精确保留可选尾部和 uint256 边界', () {
    final amount = BigInt.from(7);
    expect(encodeErc20Transfer(_erc20Recipient, amount), _erc20Input);
    expect(
      encodeErc20Transfer(
        _erc20Recipient,
        amount,
        suffix: Uint8List.fromList([0, 0xff]),
      ),
      '${_erc20Input}00ff',
    );
    final limit = BigInt.one << 256;
    expect(
      encodeErc20Transfer(_erc20Recipient, limit - BigInt.one),
      '${_erc20Input.substring(0, 74)}${'f' * 64}',
    );
    expect(
      encodeErc20Transfer(_erc20Recipient, BigInt.zero),
      '${_erc20Input.substring(0, 74)}${'0' * 64}',
    );
    expect(
      () => encodeErc20Transfer(_erc20Recipient, limit),
      throwsArgumentError,
    );
    expect(
      () => encodeErc20Transfer(_erc20Recipient, -BigInt.one),
      throwsArgumentError,
    );
    expect(() => encodeErc20Transfer('0x12', amount), throwsArgumentError);
  });

  for (final withSuffix in [false, true]) {
    test('单轮核验并定位真实付款人，尾部 $withSuffix', () async {
      final calls = <(String, List<Object?>)>[];
      final receipt = await verifyErc20Transfer(
        (method, params) async {
          calls.add((method, params));
          return _erc20Result(
            method,
            params,
            withSuffix ? 'suffix' : '',
            calls.length,
          );
        },
        chainId: 1,
        txid: _erc20Txid,
        token: _erc20Token,
        recipient: _erc20Recipient,
        amount: BigInt.from(7),
        suffix: withSuffix ? Uint8List.fromList([0xab, 0xcd]) : null,
        now: 1000000,
      );
      expect(receipt, (
        sender: _erc20Sender,
        blockHash: _erc20Block,
        blockNumber: 10,
        blockAt: 1000000,
        logIndex: 2,
        checkedAt: 1000000,
      ));
      expect(calls.map((call) => call.$1), [
        'eth_chainId',
        'eth_getTransactionReceipt',
        'eth_getTransactionByHash',
        'eth_getBlockByNumber',
        'eth_getBlockByNumber',
        'eth_getBlockByNumber',
      ]);
      expect(calls.map((call) => call.$2), [
        <Object?>[],
        [_erc20Txid],
        [_erc20Txid],
        ['0xa', false],
        ['finalized', false],
        ['0xa', false],
      ]);
    });
  }

  const failures = {
    'network': 1,
    'quantity': 1,
    'overflow': 1,
    'pending': 2,
    'failed': 2,
    'caller': 3,
    'call_to': 3,
    'native_value': 3,
    'input': 3,
    'tx_position': 3,
    'membership': 4,
    'duplicate_tx': 4,
    'unfinalized': 5,
    'before_window': 5,
    'future': 5,
    'amount': 5,
    'recipient': 5,
    'sender': 5,
    'asset': 5,
    'removed': 5,
    'duplicate_log': 5,
    'log_position': 5,
    'reorg': 6,
  };
  for (final failure in failures.entries) {
    test('拒绝 ${failure.key} 并在该步骤停止', () async {
      var calls = 0;
      await expectLater(
        verifyErc20Transfer(
          (method, params) async =>
              _erc20Result(method, params, failure.key, ++calls),
          chainId: 1,
          txid: _erc20Txid,
          token: _erc20Token,
          recipient: _erc20Recipient,
          amount: BigInt.from(7),
          sender: _erc20Sender,
          minBlockAt: failure.key == 'before_window' ? 1000001 : null,
          now: 1000000,
        ),
        throwsFormatException,
      );
      expect(calls, failure.value);
    });
  }
}

// 合成 RPC 返回真实字段形状，金额字和输入字均独立于被测编码器。
Object? _erc20Result(String method, List<Object?> params, String kind, int call) {
  final different = '0x${'66' * 32}';
  switch (method) {
    case 'eth_chainId':
      return switch (kind) {
        'network' => '0x2',
        'quantity' => '0x01',
        'overflow' => '0x20000000000000',
        _ => '0x1',
      };
    case 'eth_getTransactionReceipt':
      if (kind == 'pending') return null;
      final logSender = kind == 'sender' ? _erc20Recipient : _erc20Sender;
      final logRecipient =
          kind == 'recipient' ? _erc20Sender : _erc20Recipient;
      final log = {
        'address': kind == 'asset' ? _erc20Recipient : _erc20Token,
        'removed': kind == 'removed',
        'topics': [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          '0x${'0' * 24}${logSender.substring(2)}',
          '0x${'0' * 24}${logRecipient.substring(2)}',
        ],
        'data': '0x${'0' * 63}${kind == 'amount' ? '8' : '7'}',
        'transactionHash': _erc20Txid,
        'blockHash': kind == 'log_position' ? different : _erc20Block,
        'blockNumber': '0xa',
        'transactionIndex': '0x0',
        'logIndex': '0x2',
      };
      return {
        'transactionHash': _erc20Txid,
        'status': kind == 'failed' ? '0x0' : '0x1',
        'blockHash': _erc20Block,
        'blockNumber': '0xa',
        'transactionIndex': '0x0',
        'logs': [log, if (kind == 'duplicate_log') log],
      };
    case 'eth_getTransactionByHash':
      return {
        'hash': _erc20Txid,
        'from': kind == 'caller' ? _erc20Recipient : _erc20Sender,
        'to': kind == 'call_to' ? _erc20Recipient : _erc20Token,
        'value': kind == 'native_value' ? '0x1' : '0x0',
        'input': switch (kind) {
          'input' => '0x',
          'suffix' => '${_erc20Input}abcd',
          _ => _erc20Input,
        },
        'blockHash': _erc20Block,
        'blockNumber': '0xa',
        'transactionIndex': kind == 'tx_position' ? '0x1' : '0x0',
      };
    case 'eth_getBlockByNumber':
      if (params.first == 'finalized') {
        return {
          'hash': different,
          'number': kind == 'unfinalized' ? '0x9' : '0xb',
        };
      }
      return {
        'hash': kind == 'reorg' && call == 6 ? different : _erc20Block,
        'number': '0xa',
        'timestamp': kind == 'future' ? '0x3e9' : '0x3e8',
        'transactions': switch (kind) {
          'membership' => <String>[],
          'duplicate_tx' => [_erc20Txid, _erc20Txid],
          _ => [_erc20Txid],
        },
      };
    default:
      throw StateError('意外的 RPC 方法 $method');
  }
}
