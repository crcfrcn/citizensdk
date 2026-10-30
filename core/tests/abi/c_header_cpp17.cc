#include <cstddef>
#include <type_traits>

#include "citizensdk.h"
#include "citizensdk_host.h"

static_assert(std::is_standard_layout<citizensdk_create_options_t>::value,
              "create must be standard layout");
static_assert(
    std::is_standard_layout<citizensdk_wallet_diagnostic_info_v1_t>::value,
    "wallet diagnostic must be standard layout");
static_assert(std::is_standard_layout<
                  citizensdk_transaction_history_record_info_t>::value,
              "history record must be standard layout");

/* Compile the same public function, structure, offset and constant assertion
 * table as C++17. The shared translation unit selects C++ type traits for its
 * function signatures; this one spelling adapter covers the direct constant
 * assertions, so neither consumer contract can silently drift. */
#define _Static_assert static_assert
#include "c_header_c11.c"

static_assert(sizeof(citizensdk_host_config_v1_t) == 64, "Host ABI2 config");
static_assert(offsetof(citizensdk_host_config_v1_t, parent) == 56, "Host parent");
ABI_FUNCTION(citizensdk_host_create, citizensdk_error_code_t,
             const citizensdk_host_config_v1_t *, uint32_t,
             citizensdk_host_handle_t *);
