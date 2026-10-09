#ifndef CITIZENSDK_CPP_EVENTS_HPP
#define CITIZENSDK_CPP_EVENTS_HPP

#include <functional>
#include "citizensdk_types.h"

namespace citizen_sdk {

using EventObserver = std::function<void(const citizensdk_event_t &)>;

/* Event data and its result handle are borrowed only for the duration of
 * EventObserver. The C++ binding releases every nonzero result exactly once
 * when the observer returns (including exceptional return); observers may
 * inspect/copy it synchronously but must not retain or release the handle. */
inline bool is_request_completion(const citizensdk_event_t &event) noexcept {
  return event.event_type == CITIZENSDK_EVENT_REQUEST_COMPLETED;
}

}  // namespace citizen_sdk

#endif
