#include "session.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace esphome::voice_broker {
namespace {

using Calls = std::vector<std::string>;
using Event = Session::Event;

constexpr uint32_t T0 = 1000;

// Records what the session asks of the device; messages carry the generation they go out under.
struct Harness : Session::Device {
  Session session{*this};
  Calls calls;
  bool refuse_connect{false};

  bool connect() override {
    this->calls.push_back(this->tagged("connect"));
    return !this->refuse_connect;
  }
  void begin(const std::string &wake_word) override { this->calls.push_back(this->tagged("begin " + wake_word)); }
  void send_stop() override { this->calls.push_back(this->tagged("stop")); }
  void disconnect() override { this->calls.push_back("disconnect"); }
  void on_phase(Phase phase) override {
    this->calls.push_back(phase == Phase::LISTENING ? "listening" : phase == Phase::THINKING ? "thinking" : "replying");
  }
  void on_end() override { this->calls.push_back("end"); }
  void on_error() override { this->calls.push_back("error"); }
  void on_startup_failure(const std::string &wake_word) override { this->calls.push_back("assist " + wake_word); }

  std::string tagged(const std::string &call) const { return call + "@" + std::to_string(this->session.generation()); }
  void start() { this->session.start("jarvis", true, T0); }
  void send(Event::Type type, Phase phase = Phase::LISTENING) {
    this->session.handle({type, this->session.generation(), phase});
  }
  // Late events and timers of a conversation that already ended.
  void replay_stale(uint32_t generation) {
    for (auto type : {Event::CONNECTED, Event::DISCONNECTED, Event::END, Event::PHASE})
      this->session.handle({type, generation, Phase::LISTENING});
    this->session.tick(T0 + 2 * Session::STARTUP_TIMEOUT_MS);
  }
};

TEST(Session, WithoutATokenTheWakeWordGoesStraightToAssist) {
  Harness h;
  h.session.start("jarvis", false, T0);
  EXPECT_EQ(h.calls, (Calls{"assist jarvis"}));
  EXPECT_FALSE(h.session.running());
}

TEST(Session, AFailedStartupHandsTheWakeWordToAssistOnce) {
  struct Failure {
    const char *name;
    void (*fail)(Harness &);
  };
  const Failure failures[] = {
      {"disconnect", [](Harness &h) { h.send(Event::DISCONNECTED); }},
      {"end", [](Harness &h) { h.send(Event::END); }},
      {"timeout", [](Harness &h) { h.session.tick(T0 + Session::STARTUP_TIMEOUT_MS); }},
      {"thinking before listening",
       [](Harness &h) {
         h.send(Event::PHASE, Phase::THINKING);
         h.session.tick(T0 + Session::STARTUP_TIMEOUT_MS);
       }},
  };
  for (bool connected : {false, true}) {
    for (const auto &failure : failures) {
      SCOPED_TRACE(std::string(failure.name) + (connected ? " after connecting" : " while connecting"));
      Harness h;
      h.start();
      if (connected)
        h.send(Event::CONNECTED);
      h.session.tick(T0 + Session::STARTUP_TIMEOUT_MS - 1);
      const uint32_t generation = h.session.generation();
      failure.fail(h);
      Calls expected{"connect@1"};
      if (connected)
        expected.push_back("begin jarvis@1");
      expected.insert(expected.end(), {"disconnect", "end", "assist jarvis"});
      EXPECT_EQ(h.calls, expected);
      h.replay_stale(generation);
      EXPECT_EQ(h.calls, expected);
      EXPECT_FALSE(h.session.running());
    }
  }

  Harness refused;
  refused.refuse_connect = true;
  refused.start();
  EXPECT_EQ(refused.calls, (Calls{"connect@1", "disconnect", "end", "assist jarvis"}));
}

TEST(Session, PastListeningAFailureEndsTheConversationWithoutAssist) {
  Harness h;
  h.start();
  h.send(Event::CONNECTED);
  h.send(Event::PHASE, Phase::LISTENING);
  h.session.tick(T0 + 2 * Session::STARTUP_TIMEOUT_MS);
  h.send(Event::PHASE, Phase::REPLYING);
  ASSERT_TRUE(h.session.active());
  h.send(Event::DISCONNECTED);
  EXPECT_EQ(h.calls, (Calls{"connect@1", "begin jarvis@1", "listening", "replying", "error", "disconnect", "end"}));
}

TEST(Session, AStopNeverHandsTheWakeWordToAssist) {
  for (int stage = 0; stage < 3; ++stage) {
    SCOPED_TRACE(stage);
    Harness h;
    h.start();
    if (stage > 0)
      h.send(Event::CONNECTED);
    if (stage > 1)
      h.send(Event::PHASE, Phase::LISTENING);
    const uint32_t generation = h.session.generation();
    h.session.stop();
    h.replay_stale(generation);
    EXPECT_EQ(std::count(h.calls.begin(), h.calls.end(), "assist jarvis"), 0);
    EXPECT_EQ(h.calls.back(), "end");
    EXPECT_FALSE(h.session.running());
  }

  // the broker hears the stop before the connection closes
  Harness h;
  h.start();
  h.send(Event::CONNECTED);
  h.send(Event::PHASE, Phase::LISTENING);
  h.session.stop();
  EXPECT_EQ(h.calls, (Calls{"connect@1", "begin jarvis@1", "listening", "stop@1", "disconnect", "end"}));
}

TEST(Session, TheStartupTimeoutSurvivesTheClockWrapping) {
  Harness h;
  const uint32_t start = UINT32_MAX - 1000;
  h.session.start("jarvis", true, start);
  h.session.tick(start + 1);
  h.session.tick(start + Session::STARTUP_TIMEOUT_MS - 1);
  EXPECT_TRUE(h.session.running());
  h.session.tick(start + Session::STARTUP_TIMEOUT_MS);
  EXPECT_FALSE(h.session.running());
}

}  // namespace
}  // namespace esphome::voice_broker
