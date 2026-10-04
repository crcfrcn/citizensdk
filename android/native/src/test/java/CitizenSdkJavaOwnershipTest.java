package org.citizen.sdk;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import org.junit.Test;

public final class CitizenSdkJavaOwnershipTest {
  @Test
  public void operationExposesCorrelationAndCancelButNoCoreHandle() throws Exception {
    Method cancel = CitizenSdkOperation.class.getMethod("cancel");
    Method operationId = CitizenSdkOperation.class.getMethod("getOperationId");
    assertNotNull(cancel);
    assertNotNull(operationId);
    assertTrue(
        java.util.Arrays.stream(CitizenSdkOperation.class.getMethods())
            .noneMatch(method -> method.getName().toLowerCase().contains("handle")));
  }

  @Test
  public void secretAndHandleEntrypointsAreNotJavaSourceApi() throws Exception {
    // 显式创建/导入接收有界输入是公开合同，不再要求由SDK窗口收集。
    assertNotNull(CitizenSdk.class.getMethod("importWallet", byte[].class, byte[].class));
    assertNotNull(CitizenSdk.class.getMethod("prepareWalletCreation", int.class, byte[].class));
    assertNotNull(CitizenWalletInspection.class.getMethod("release"));

    ClassLoader loader = CitizenSdkJavaOwnershipTest.class.getClassLoader();
    Class<?> nativeOwner =
        Class.forName("org.citizen.sdk.internal.CitizenSdkNative", false, loader);
    assertTrue(
        java.util.Arrays.stream(nativeOwner.getDeclaredConstructors())
            .allMatch(
                constructor ->
                    Modifier.isPrivate(constructor.getModifiers()) || constructor.isSynthetic()));
    Class<?> prepared =
        Class.forName("org.citizen.sdk.CitizenSdkPreparedWallet", false, loader);
    assertTrue(
        java.util.Arrays.stream(prepared.getDeclaredConstructors())
            .allMatch(
                constructor ->
                    Modifier.isPrivate(constructor.getModifiers()) || constructor.isSynthetic()));

    assertThrows(ClassNotFoundException.class, () ->
        Class.forName("org.citizen.sdk.ui.CitizenSdkWalletFlowCoordinator", false, loader));
  }
}
