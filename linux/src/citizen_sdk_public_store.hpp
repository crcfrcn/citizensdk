#ifndef CITIZENSDK_LINUX_PUBLIC_STORE_HPP
#define CITIZENSDK_LINUX_PUBLIC_STORE_HPP

#include <array>
#include <filesystem>
#include "citizen_sdk_sqlite.hpp"

namespace citizen_sdk::linux {

class PublicStore final : public SQLiteStore {
 public:
  explicit PublicStore(const std::filesystem::path &directory);

  HostRecord chain_database_load();
  HostRecord chain_database_compare_and_swap(uint64_t expected,
                                             const Bytes &candidate);
  /// Runs Core's fixed THQ1 index/exact/page query against indexed rows.
  HostRecord transaction_history_query(const Bytes &query);
  /// Applies one THM1 delete/upsert/meta transition atomically.
  HostRecord transaction_history_mutate(uint64_t expected,
                                        const Bytes &mutation);
  HostRecord runtime_cache_load(const std::array<uint8_t, 32> &hash);
  void runtime_cache_store(const std::array<uint8_t, 32> &hash,
                           const Bytes &candidate);
  void runtime_cache_delete(const std::array<uint8_t, 32> &hash);

 private:
  HostRecord singleton_load(citizensdk_host_record_domain_t domain);
  HostRecord singleton_compare_and_swap(citizensdk_host_record_domain_t domain,
                                        uint64_t expected,
                                        const Bytes &candidate);
  void reclaim_history_pages();
};

}  // namespace citizen_sdk::linux

#endif
