import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

// Flutter 只验证安装包资产投影；信任验证、#0 锚和运行时注入由原生 Core 测试覆盖。
void main() {
  test('Flutter 安装包保留唯一公民链三文件信任闭集及固定身份', () async {
    const root = 'chain';
    expect(Directory('assets').existsSync(), isFalse);
    expect(
      Directory(root)
          .listSync()
          .map((file) => file.uri.pathSegments.last)
          .toList()
        ..sort(),
      ['chainspec.json', 'light_sync_state.json', 'manifest.json'],
    );
    final manifest = jsonDecode(
      await File('$root/manifest.json').readAsString(),
    ) as Map<String, dynamic>;
    final specBytes = await File('$root/chainspec.json').readAsBytes();
    final syncBytes = await File('$root/light_sync_state.json').readAsBytes();
    final spec = jsonDecode(utf8.decode(specBytes)) as Map<String, dynamic>;
    expect(manifest['chain_id'], 'citizenchain');
    expect(manifest['protocol_id'], 'citizenchain');
    expect(manifest['product_id'], 'citizensdk');
    expect(manifest['chainspec_sha256'], sha256.convert(specBytes).toString());
    expect(
      manifest['light_sync_state_sha256'],
      sha256.convert(syncBytes).toString(),
    );
    expect(spec['id'], manifest['chain_id']);
    expect(spec['protocolId'], manifest['protocol_id']);
    expect(File('pubspec.yaml').readAsStringSync(), contains('- chain/'));
    expect(spec['bootNodes'], hasLength(5));
    final nodes = (spec['bootNodes'] as List).cast<String>();
    expect(nodes.toSet(), hasLength(5));
    for (final host in ['nrcgch', 'prczss', 'prcgzs', 'prches', 'prchbs']) {
      expect(
        nodes.where((node) => node.startsWith('/dns4/$host.crcfrcn.com/')),
        hasLength(1),
      );
    }
  });

  test('启动清单 fixture 保持服务端共同消费的原有 wire 合同', () async {
    final wire = jsonDecode(
      await File('test/node/citizensdk_bootstrap_manifest.json').readAsString(),
    ) as Map<String, dynamic>;
    expect(wire['schema'], 'citizensdk.chain.bootstrap');
    final client = wire['light_client'] as Map<String, dynamic>;
    expect(client['api_is_truth'], isFalse);
    expect(client['truth_source'], 'p2p_finalized_storage');
    expect(
      (wire['security'] as Map<String, dynamic>).values,
      everyElement(isFalse),
    );
  });
}
