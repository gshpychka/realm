#pragma once

// Streams a conversation to the voice broker (packages/voice-broker):
// mic audio up, assistant audio down, and exact DAC timing of what was played
// so the broker can cancel the speaker's echo.
//
// Threads involved, and what each is allowed to touch:
//   main loop    session state machine, speaker writes, automation triggers
//   io task      every esp_websocket_client call that can block (open, send,
//                close, destroy); fed through io_queue_
//   ws task      esp_websocket_client's event handler: parses incoming frames,
//                writes audio into playback_, posts events to event_queue_
//   mic task     microphone callback: frames mic audio into io_queue_
//   audio task   speaker output callback: frames PLAYED reports into io_queue_

#include "credential.h"
#include "protocol.h"
#include "session.h"
#include "esphome/components/api/custom_api_device.h"
#include "esphome/core/preferences.h"

#ifndef USE_API_NOISE
#error "voice_broker credential provisioning requires API Noise encryption"
#endif
#ifdef USE_API_PLAINTEXT
#error "voice_broker credential provisioning must not accept plaintext API connections"
#endif

#include "esphome/components/microphone/microphone_source.h"
#include "esphome/components/ring_buffer/ring_buffer.h"
#include "esphome/components/speaker/speaker.h"
#include "esphome/core/automation.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"

#include <esp_websocket_client.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include <atomic>
#include <initializer_list>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace esphome::voice_broker {

class VoiceBroker : public Component, public api::CustomAPIDevice, protected Session::Device {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  void set_url(const std::string &url) { this->url_ = url; }
  void provision_token(std::string token);
  void set_microphone_source(microphone::MicrophoneSource *source) { this->mic_source_ = source; }
  void set_speaker(speaker::Speaker *speaker) { this->speaker_ = speaker; }

  Trigger<std::string> *get_phase_trigger() { return &this->phase_trigger_; }
  Trigger<> *get_end_trigger() { return &this->end_trigger_; }
  Trigger<> *get_error_trigger() { return &this->error_trigger_; }

  Trigger<std::string> *get_startup_failure_trigger() { return &this->startup_failure_trigger_; }

  // Opens a conversation; no-op if one is running.
  void start(const std::string &wake_word);
  // Ends the conversation from the device side (button, wake word).
  void stop();
  bool is_running() const { return this->session_.running(); }

 protected:
  using Event = Session::Event;

  struct IoItem {
    enum Op : uint8_t { OPEN, CLOSE, BINARY, TEXT } op;
    uint32_t generation;
    uint8_t *data;  // heap, owned by the item; freed by the io task
    size_t len;
  };

  // esp_websocket_client's handler argument: ties events to the connection
  // they came from, so late events from a closed one are ignored.
  struct HandlerContext {
    VoiceBroker *parent;
    uint32_t generation;
  };

  bool connect() override;
  void begin(const std::string &wake_word) override;
  void send_stop() override;
  void disconnect() override;
  void on_phase(Phase phase) override;
  void on_end() override;
  void on_error() override;
  void on_startup_failure(const std::string &wake_word) override;

  static void io_task_(void *arg);
  void io_open_(uint32_t generation);
  void io_close_();
  static void ws_event_handler_(void *arg, esp_event_base_t base, int32_t event_id, void *event_data);
  void on_ws_data_(uint32_t generation, const esp_websocket_event_data_t *data);
  void on_control_(uint32_t generation, const std::string &text);

  void on_mic_data_(const std::vector<uint8_t> &data);
  void on_audio_output_(uint32_t frames, int64_t timestamp_us);

  void post_event_(Event::Type type, uint32_t generation, Phase phase = Phase::LISTENING);
  bool queue_io_(IoItem::Op op, uint8_t *data = nullptr, size_t len = 0);
  void queue_control_(const char *type, std::initializer_list<std::pair<const char *, std::string>> fields = {});
  void feed_speaker_();

  std::string url_;
  struct SavedToken { char value[Credential::MAX_SIZE + 1]{}; };
  Credential credential_;
  ESPPreferenceObject token_preference_;
  microphone::MicrophoneSource *mic_source_{nullptr};
  speaker::Speaker *speaker_{nullptr};

  Trigger<std::string> phase_trigger_;
  Trigger<> end_trigger_;
  Trigger<> error_trigger_;
  Trigger<std::string> startup_failure_trigger_;

  Session session_{*this};
  // Mic and speaker callbacks only produce frames while this is set.
  std::atomic<bool> streaming_{false};

  QueueHandle_t io_queue_{nullptr};
  QueueHandle_t event_queue_{nullptr};

  // io task only
  esp_websocket_client_handle_t client_{nullptr};
  HandlerContext *handler_context_{nullptr};
  std::string headers_;

  // ws task only
  uint8_t frame_kind_{0};
  bool frame_is_text_{false};
  std::string text_frame_;

  // mic task only
  uint32_t mic_samples_{0};

  std::unique_ptr<ring_buffer::RingBuffer> playback_;
  std::vector<uint8_t> play_holdover_;
  size_t play_holdover_offset_{0};

  HighFrequencyLoopRequester high_freq_;
};

template<typename... Ts> class StartAction : public Action<Ts...>, public Parented<VoiceBroker> {
 public:
  TEMPLATABLE_VALUE(std::string, wake_word)
  void play(const Ts &...x) override { this->parent_->start(this->wake_word_.value(x...)); }
};

template<typename... Ts> class StopAction : public Action<Ts...>, public Parented<VoiceBroker> {
 public:
  void play(const Ts &...x) override { this->parent_->stop(); }
};

template<typename... Ts> class IsRunningCondition : public Condition<Ts...>, public Parented<VoiceBroker> {
 public:
  bool check(const Ts &...x) override { return this->parent_->is_running(); }
};

}  // namespace esphome::voice_broker
