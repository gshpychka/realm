#include "session.h"

namespace esphome::voice_broker {

void Session::start(const std::string &wake_word, bool can_connect, uint32_t now_ms) {
  if (this->running())
    return;
  if (!can_connect) {
    this->device_.on_startup_failure(wake_word);
    return;
  }
  this->wake_word_ = wake_word;
  this->started_ms_ = now_ms;
  this->generation_++;
  this->state_ = State::CONNECTING;
  if (!this->device_.connect())
    this->fail_startup_();
}

void Session::stop() {
  if (this->state_ == State::ACTIVE)
    this->device_.send_stop();
  if (this->running())
    this->teardown_();
}

void Session::handle(const Event &event) {
  if (event.generation != this->generation_)
    return;
  switch (event.type) {
    case Event::CONNECTED:
      if (this->state_ != State::CONNECTING)
        break;
      this->state_ = State::WAITING_READY;
      // Speech right after the wake word streams while the model starts up.
      this->device_.begin(this->wake_word_);
      break;
    case Event::DISCONNECTED:
      if (this->starting_()) {
        this->fail_startup_();
      } else {
        this->device_.on_error();
        this->teardown_();
      }
      break;
    case Event::END:
      if (this->starting_())
        this->fail_startup_();
      else
        this->teardown_();
      break;
    case Event::PHASE:
      // The broker listens only once its model session is open.
      if (this->state_ == State::WAITING_READY && event.phase == Phase::LISTENING)
        this->state_ = State::ACTIVE;
      if (this->state_ == State::ACTIVE)
        this->device_.on_phase(event.phase);
      break;
  }
}

void Session::tick(uint32_t now_ms) {
  // Unsigned difference survives the clock wrapping.
  if (this->starting_() && now_ms - this->started_ms_ >= STARTUP_TIMEOUT_MS)
    this->fail_startup_();
}

void Session::fail_startup_() {
  this->teardown_();
  this->device_.on_startup_failure(this->wake_word_);
}

void Session::teardown_() {
  this->device_.disconnect();
  // Anything still in flight from this conversation is now stale.
  this->generation_++;
  this->state_ = State::IDLE;
  this->device_.on_end();
}

}  // namespace esphome::voice_broker
