#pragma once

#include <cstddef>
#include <mutex>
#include <string>

namespace esphome::voice_broker {

// The broker's bearer token; any task may read it.
class Credential {
 public:
  // Longest token the device stores.
  static constexpr size_t MAX_SIZE = 256;

  // Whether `token` fits the Authorization header: at most MAX_SIZE visible ASCII characters.
  static bool valid(const std::string &token) {
    if (token.size() > MAX_SIZE)
      return false;
    for (unsigned char c : token) {
      if (c < '!' || c > '~')
        return false;
    }
    return true;
  }

  // Adopts a valid `token` once `store(token)` has persisted it; an empty token clears the credential.
  // `store` sees only valid tokens.
  template<typename Store> bool replace(const std::string &token, Store &&store) {
    if (!valid(token) || !store(token))
      return false;
    std::lock_guard<std::mutex> lock(this->mutex_);
    this->token_ = token;
    return true;
  }

  // Adopts a token read back from storage.
  bool restore(const std::string &token) {
    return this->replace(token, [](const std::string &) { return true; });
  }

  std::string get() const {
    std::lock_guard<std::mutex> lock(this->mutex_);
    return this->token_;
  }

 private:
  mutable std::mutex mutex_;
  std::string token_;
};

}  // namespace esphome::voice_broker
