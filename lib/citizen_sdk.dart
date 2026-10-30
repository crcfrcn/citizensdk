// ignore: unnecessary_library_name -- 正式包唯一库标识。
library citizen_sdk;

import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'package:ffi/ffi.dart';
import 'package:flutter/services.dart' hide Size;
import 'package:flutter/widgets.dart' hide Size;
import 'account_codec.dart';
import 'platform/bind.dart' as c;
export 'account_codec.dart';

part 'api/citizen_sdk.dart';
part 'api/citizen_chain.dart';
part 'api/citizen_sdk_wallet.dart';
part 'api/citizen_transactions.dart';
part 'api/citizen_qr.dart';
part 'api/citizen_sdk_error.dart';
part 'api/citizen_sdk_events.dart';
part 'models/citizen_account.dart';
part 'models/citizen_capability.dart';
part 'models/citizen_chain_state.dart';
part 'models/citizen_signing.dart';
part 'models/citizen_transaction.dart';
part 'models/citizen_wallet.dart';
part 'platform/memory.dart';
