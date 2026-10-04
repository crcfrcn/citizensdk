/// 一条公民链账户的公开资料。
final class CitizenAccount {
  CitizenAccount({
    required this.index,
    required this.accountId,
    required this.ss58Address,
    required this.name,
    required this.createdAtMillis,
    required this.isActive,
  }) {
    if (index < 0) throw ArgumentError.value(index, 'index');
  }

  /// 钱包派生序号；这是公开账户资料，不是秘密派生输入。
  final int index;
  final String accountId;
  final String ss58Address;
  final String name;
  final BigInt createdAtMillis;
  final bool isActive;

  String get derivationPath => '//$index';
}
