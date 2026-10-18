#pragma once

#include <atomic>
#include <cstdint>
#include <string>

namespace esphome::voice_broker {

enum class Phase : uint8_t { LISTENING, THINKING, REPLYING };

// One conversation at a time: a bounded startup that hands the wake word to Assist
// when it fails, then a live session that ends without fallback.
class Session {
 public:
  // Connection plus model startup.
  static constexpr uint32_t STARTUP_TIMEOUT_MS = 10000;

  // What the broker connection reports, tagged with the conversation it belongs to.
  struct Event {
    enum Type : uint8_t { CONNECTED, DISCONNECTED, END, PHASE } type;
    uint32_t generation;
    Phase phase;
  };

  // The device's side of a conversation.
  class Device {
   public:
    // Opens the broker connection for the current generation; false when it can't.
    virtual bool connect() = 0;
    // Asks the broker to start and streams the mic.
    virtual void begin(const std::string &wake_word) = 0;
    // Tells the broker the user ended the conversation.
    virtual void send_stop() = 0;
    // Stops audio and closes the connection.
    virtual void disconnect() = 0;
    virtual void on_phase(Phase phase) = 0;
    virtual void on_end() = 0;
    // A live conversation dropped by the broker; precedes its on_end.
    virtual void on_error() = 0;
    // Hands the wake word to Assist; follows the failed conversation's on_end.
    virtual void on_startup_failure(const std::string &wake_word) = 0;

   protected:
    ~Device() = default;
  };

  explicit Session(Device &device) : device_(device) {}

  // Opens a conversation unless one is running; without `can_connect`, hands the wake word to Assist.
  void start(const std::string &wake_word, bool can_connect, uint32_t now_ms);
  // Ends the conversation from the device side.
  void stop();
  void handle(const Event &event);
  void tick(uint32_t now_ms);

  bool running() const { return this->state_ != State::IDLE; }
  bool active() const { return this->state_ == State::ACTIVE; }
  // The current conversation; anything tagged with another is stale. Any task may read it.
  uint32_t generation() const { return this->generation_; }

 protected:
  enum class State : uint8_t { IDLE, CONNECTING, WAITING_READY, ACTIVE };

  bool starting_() const { return this->state_ == State::CONNECTING || this->state_ == State::WAITING_READY; }
  void fail_startup_();
  void teardown_();

  Device &device_;
  State state_{State::IDLE};
  std::string wake_word_;
  uint32_t started_ms_{0};
  std::atomic<uint32_t> generation_{0};
};

}  // namespace esphome::voice_broker
