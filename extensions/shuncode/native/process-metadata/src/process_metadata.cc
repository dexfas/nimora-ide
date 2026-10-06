#include <node_api.h>
#include <windows.h>

#include <cstdint>

namespace {

constexpr uint64_t kWindowsToUnixEpoch100ns = 116444736000000000ULL;

void SetString(napi_env env, napi_value object, const char* key, const char* value) {
  napi_value js_value;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &js_value);
  napi_set_named_property(env, object, key, js_value);
}

void SetDouble(napi_env env, napi_value object, const char* key, double value) {
  napi_value js_value;
  napi_create_double(env, value, &js_value);
  napi_set_named_property(env, object, key, js_value);
}

napi_value ObserveProcess(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  napi_value result;
  napi_create_object(env, &result);
  if (argc != 1) {
    SetString(env, result, "liveness", "unknown");
    return result;
  }

  uint32_t process_id = 0;
  if (napi_get_value_uint32(env, argv[0], &process_id) != napi_ok || process_id == 0) {
    SetString(env, result, "liveness", "unknown");
    return result;
  }

  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (process == nullptr) {
    SetString(env, result, "liveness", GetLastError() == ERROR_INVALID_PARAMETER ? "dead" : "unknown");
    return result;
  }

  DWORD exit_code = 0;
  if (!GetExitCodeProcess(process, &exit_code)) {
    CloseHandle(process);
    SetString(env, result, "liveness", "unknown");
    return result;
  }
  if (exit_code != STILL_ACTIVE) {
    CloseHandle(process);
    SetString(env, result, "liveness", "dead");
    return result;
  }

  FILETIME creation_time, exit_time, kernel_time, user_time;
  if (!GetProcessTimes(process, &creation_time, &exit_time, &kernel_time, &user_time)) {
    CloseHandle(process);
    SetString(env, result, "liveness", "alive");
    return result;
  }
  CloseHandle(process);

  ULARGE_INTEGER creation_ticks;
  creation_ticks.LowPart = creation_time.dwLowDateTime;
  creation_ticks.HighPart = creation_time.dwHighDateTime;
  if (creation_ticks.QuadPart <= kWindowsToUnixEpoch100ns) {
    SetString(env, result, "liveness", "alive");
    return result;
  }

  const uint64_t unix_ms = (creation_ticks.QuadPart - kWindowsToUnixEpoch100ns) / 10000ULL;
  SetString(env, result, "liveness", "alive");
  SetDouble(env, result, "creationTimeMs", static_cast<double>(unix_ms));
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value observe;
  napi_create_function(env, "observeProcess", NAPI_AUTO_LENGTH, ObserveProcess, nullptr, &observe);
  napi_set_named_property(env, exports, "observeProcess", observe);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
