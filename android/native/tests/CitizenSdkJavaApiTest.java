package org.citizen.sdk;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class CitizenSdkJavaApiTest {
  @Test
  public void u128KeepsExactUnsignedDecimal() {
    CitizenU128 value = new CitizenU128("340282366920938463463374607431768211455");
    assertEquals("340282366920938463463374607431768211455", value.getDecimal());
  }
}

