#include "voice_broker.h"
#include "protocol.h"

#include "esphome/components/audio/audio.h"
#include "esphome/components/json/json_util.h"
#include "esphome/core/hal.h"
#include "esphome/core/log.h"

#include <esp_heap_caps.h>
#include <esp_timer.h>

#include <cstring>

namespace esphome::voice_broker {

static const char *const TAG = "voice_broker";

// Up to ~1 s of mic frames plus PLAYED reports and control messages.
static constexpr size_t IO_QUEUE_LENGTH = 96;
static constexpr size_t EVENT_QUEUE_LENGTH = 16;
// The broker keeps ~300 ms queued here; the rest is slack for network bursts.
static constexpr size_t PLAYBACK_BUFFER_BYTES = protocol::SPEAKER_RATE * sizeof(int16_t) * 2;
static constexpr size_t SPEAKER_WRITE_BYTES = 4096;
static constexpr uint32_t IO_TASK_STACK = 6144;
static constexpr TickType_t SEND_TIMEOUT = pdMS_TO_TICKS(100);
static constexpr TickType_t CLOSE_TIMEOUT = pdMS_TO_TICKS(500);

static uint8_t *alloc_frame(size_t len) {
  return static_cast<uint8_t *>(heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
}

void VoiceBroker::provision_token(std::string token) {
  // Only a nonzero Noise key authenticates the caller.
  if (!api::global_api_server->get_noise_ctx().has_psk() || this->is_running())
    return;
  const bool replaced = this->credential_.replace(token, [this](const std::string &valid) {
    SavedToken saved{};
    std::memcpy(saved.value, valid.data(), valid.size());
    return this->token_preference_.save(&saved) && global_preferences->sync();
  });
  if (!replaced)
    ESP_LOGW(TAG, "Token invalid or not persisted");
}

void VoiceBroker::setup() {
  static_assert(sizeof(SavedToken) == 257);
  this->token_preference_ = global_preferences->make_preference<SavedToken>(0x56425401);
  SavedToken saved{};
  if (this->token_preference_.load(&saved) && saved.value[Credential::MAX_SIZE] == 0)
    this->credential_.restore(saved.value);
  this->register_service(&VoiceBroker::provision_token, "provision_voice_broker_token", {"token"});
  this->io_queue_ = xQueueCreate(IO_QUEUE_LENGTH, sizeof(IoItem));
  this->event_queue_ = xQueueCreate(EVENT_QUEUE_LENGTH, sizeof(Event));
  this->playback_ = ring_buffer::RingBuffer::create(PLAYBACK_BUFFER_BYTES);
  if (this->io_queue_ == nullptr || this->event_queue_ == nullptr || this->playback_ == nullptr ||
      xTaskCreate(VoiceBroker::io_task_, "voice_broker_io", IO_TASK_STACK, this, 5, nullptr) != pdPASS) {
    ESP_LOGE(TAG, "Failed to allocate queues, buffer or io task");
    this->mark_failed();
    return;
  }
  this->mic_source_->add_data_callback([this](const std::vector<uint8_t> &data) { this->on_mic_data_(data); });
  this->speaker_->add_audio_output_callback(
      [this](uint32_t frames, int64_t timestamp_us) { this->on_audio_output_(frames, timestamp_us); });
}

void VoiceBroker::dump_config() {
  ESP_LOGCONFIG(TAG, "Voice broker:\n  URL: %s", this->url_.c_str());
}

// -- conversation (main loop) -------------------------------------------------

void VoiceBroker::start(const std::string &wake_word) {
  this->session_.start(wake_word, !this->is_failed() && !this->credential_.get().empty(), millis());
}

void VoiceBroker::stop() { this->session_.stop(); }

void VoiceBroker::loop() {
  Event event;
  while (xQueueReceive(this->event_queue_, &event, 0) == pdTRUE)
    this->session_.handle(event);
  this->session_.tick(millis());
  if (this->session_.active())
    this->feed_speaker_();
}

bool VoiceBroker::connect() {
  this->high_freq_.start();
  return this->queue_io_(IoItem::OPEN);
}

void VoiceBroker::begin(const std::string &wake_word) {
  this->queue_control_(protocol::START, {{"wake_word", wake_word}});
  this->mic_samples_ = 0;
  this->streaming_ = true;
  this->mic_source_->start();
}

void VoiceBroker::send_stop() { this->queue_control_(protocol::STOP); }

void VoiceBroker::disconnect() {
  this->streaming_ = false;
  this->mic_source_->stop();
  this->speaker_->stop();
  this->playback_->reset();
  this->play_holdover_.clear();
  this->play_holdover_offset_ = 0;
  // Queued after anything already pending, so a STOP goes out before the close.
  this->queue_io_(IoItem::CLOSE);
  this->high_freq_.stop();
}

void VoiceBroker::on_phase(Phase phase) {
  switch (phase) {
    case Phase::LISTENING:
      this->phase_trigger_.trigger("listening");
      break;
    case Phase::THINKING:
      this->phase_trigger_.trigger("thinking");
      break;
    case Phase::REPLYING:
      this->phase_trigger_.trigger("replying");
      break;
  }
}

void VoiceBroker::on_end() { this->end_trigger_.trigger(); }

void VoiceBroker::on_error() { this->error_trigger_.trigger(); }

void VoiceBroker::on_startup_failure(const std::string &wake_word) {
  ESP_LOGW(TAG, "Live startup failed; handing wake word to Assist (no audio replay)");
  this->startup_failure_trigger_.trigger(wake_word);
}

void VoiceBroker::feed_speaker_() {
  if (this->play_holdover_.empty()) {
    // Whole samples only: a WebSocket fragment can end mid-sample.
    size_t available = this->playback_->available() & ~static_cast<size_t>(1);
    if (available == 0)
      return;
    this->play_holdover_.resize(std::min(available, SPEAKER_WRITE_BYTES));
    size_t read = this->playback_->read(this->play_holdover_.data(), this->play_holdover_.size(), 0);
    this->play_holdover_.resize(read);
    this->play_holdover_offset_ = 0;
    if (read == 0)
      return;
  }
  if (this->speaker_->is_stopped()) {
    this->speaker_->set_audio_stream_info(audio::AudioStreamInfo(16, 1, protocol::SPEAKER_RATE));
    this->speaker_->start();
  }
  if (!this->speaker_->is_running())
    return;
  size_t written = this->speaker_->play(this->play_holdover_.data() + this->play_holdover_offset_,
                                        this->play_holdover_.size() - this->play_holdover_offset_, 0);
  this->play_holdover_offset_ += written;
  if (this->play_holdover_offset_ >= this->play_holdover_.size()) {
    this->play_holdover_.clear();
    this->play_holdover_offset_ = 0;
  }
}

// -- producers (mic task, audio task, main loop) ------------------------------

bool VoiceBroker::queue_io_(IoItem::Op op, uint8_t *data, size_t len) {
  IoItem item{op, this->session_.generation(), data, len};
  if (xQueueSend(this->io_queue_, &item, 0) != pdTRUE) {
    free(data);
    return false;
  }
  return true;
}

void VoiceBroker::queue_control_(const char *type,
                                   std::initializer_list<std::pair<const char *, std::string>> fields) {
  std::string text = json::build_json([&](JsonObject root) {
    root["type"] = type;
    for (const auto &[key, value] : fields)
      root[key] = value;
  });
  uint8_t *data = alloc_frame(text.size());
  if (data == nullptr)
    return;
  std::memcpy(data, text.data(), text.size());
  if (!this->queue_io_(IoItem::TEXT, data, text.size()))
    ESP_LOGW(TAG, "io queue full, dropped control %s", type);
}

void VoiceBroker::on_mic_data_(const std::vector<uint8_t> &data) {
  if (!this->streaming_)
    return;
  const uint32_t samples = data.size() / sizeof(int16_t);
  const uint32_t first = this->mic_samples_;
  // Samples are counted even when a frame is dropped, so the broker sees the gap.
  this->mic_samples_ += samples;
  // The callback runs right after the I2S read that produced these samples.
  const int64_t capture_us =
      esp_timer_get_time() - static_cast<int64_t>(samples) * 1000000 / protocol::MIC_RATE;

  const size_t len = protocol::MIC_HEADER_SIZE + data.size();
  uint8_t *frame = alloc_frame(len);
  if (frame == nullptr)
    return;
  frame[0] = protocol::KIND_MIC;
  protocol::put_u32(frame + 1, first);
  protocol::put_i64(frame + 5, capture_us);
  std::memcpy(frame + protocol::MIC_HEADER_SIZE, data.data(), data.size());
  this->queue_io_(IoItem::BINARY, frame, len);
}

void VoiceBroker::on_audio_output_(uint32_t frames, int64_t timestamp_us) {
  if (!this->streaming_ || frames == 0)
    return;
  uint8_t *frame = alloc_frame(protocol::PLAYED_SIZE);
  if (frame == nullptr)
    return;
  frame[0] = protocol::KIND_PLAYED;
  protocol::put_u32(frame + 1, frames);
  protocol::put_i64(frame + 5, timestamp_us);
  if (!this->queue_io_(IoItem::BINARY, frame, protocol::PLAYED_SIZE))
    ESP_LOGW(TAG, "io queue full, dropped a PLAYED report");
}

void VoiceBroker::post_event_(Event::Type type, uint32_t generation, Phase phase) {
  Event event{type, generation, phase};
  if (xQueueSend(this->event_queue_, &event, 0) != pdTRUE)
    ESP_LOGW(TAG, "event queue full");
}

// -- io task ------------------------------------------------------------------

void VoiceBroker::io_task_(void *arg) {
  auto *self = static_cast<VoiceBroker *>(arg);
  // Generation of the connection client_ belongs to; frames from other
  // conversations are dropped.
  uint32_t client_generation = 0;
  IoItem item;
  while (true) {
    if (xQueueReceive(self->io_queue_, &item, portMAX_DELAY) != pdTRUE)
      continue;
    switch (item.op) {
      case IoItem::OPEN:
        if (item.generation != self->session_.generation())
          break;  // Cancelled/timed-out startup must not open a stale session.
        self->io_close_();
        client_generation = item.generation;
        self->io_open_(item.generation);
        break;
      case IoItem::CLOSE:
        self->io_close_();
        break;
      case IoItem::BINARY:
      case IoItem::TEXT:
        if (self->client_ != nullptr && item.generation == client_generation &&
            esp_websocket_client_is_connected(self->client_)) {
          int sent = item.op == IoItem::BINARY
                         ? esp_websocket_client_send_bin(self->client_, reinterpret_cast<const char *>(item.data),
                                                         item.len, SEND_TIMEOUT)
                         : esp_websocket_client_send_text(self->client_, reinterpret_cast<const char *>(item.data),
                                                          item.len, SEND_TIMEOUT);
          if (sent < 0)
            ESP_LOGW(TAG, "send failed");
        }
        break;
    }
    free(item.data);
  }
}

void VoiceBroker::io_open_(uint32_t generation) {
  this->headers_ = "Authorization: Bearer " + this->credential_.get() + "\r\n";
  esp_websocket_client_config_t config = {};
  config.uri = this->url_.c_str();
  config.headers = this->headers_.c_str();
  // Assistant audio arrives in 40 ms frames (1921 bytes); fit one per event.
  config.buffer_size = 4096;
  // A dropped conversation ends; the next wake word opens a new one.
  config.disable_auto_reconnect = true;
  config.network_timeout_ms = 5000;
  config.ping_interval_sec = 5;
  config.pingpong_timeout_sec = 10;
  config.task_stack = 6144;

  this->handler_context_ = new HandlerContext{this, generation};
  this->client_ = esp_websocket_client_init(&config);
  if (this->client_ == nullptr) {
    ESP_LOGE(TAG, "esp_websocket_client_init failed");
    this->post_event_(Event::DISCONNECTED, generation);
    delete this->handler_context_;
    this->handler_context_ = nullptr;
    return;
  }
  esp_websocket_register_events(this->client_, WEBSOCKET_EVENT_ANY, VoiceBroker::ws_event_handler_,
                                this->handler_context_);
  if (esp_websocket_client_start(this->client_) != ESP_OK) {
    ESP_LOGE(TAG, "esp_websocket_client_start failed");
    this->post_event_(Event::DISCONNECTED, generation);
    this->io_close_();
  }
}

void VoiceBroker::io_close_() {
  if (this->client_ == nullptr)
    return;
  if (esp_websocket_client_is_connected(this->client_))
    esp_websocket_client_close(this->client_, CLOSE_TIMEOUT);
  esp_websocket_client_destroy(this->client_);
  this->client_ = nullptr;
  // Destroy has stopped the client's task, so the handler can't run anymore.
  delete this->handler_context_;
  this->handler_context_ = nullptr;
}

// -- ws task ------------------------------------------------------------------

void VoiceBroker::ws_event_handler_(void *arg, esp_event_base_t base, int32_t event_id, void *event_data) {
  auto *context = static_cast<HandlerContext *>(arg);
  auto *self = context->parent;
  switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
      self->post_event_(Event::CONNECTED, context->generation);
      break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
    case WEBSOCKET_EVENT_ERROR:
      self->post_event_(Event::DISCONNECTED, context->generation);
      break;
    case WEBSOCKET_EVENT_DATA:
      self->on_ws_data_(context->generation, static_cast<esp_websocket_event_data_t *>(event_data));
      break;
    default:
      break;
  }
}

void VoiceBroker::on_ws_data_(uint32_t generation, const esp_websocket_event_data_t *data) {
  if (generation != this->session_.generation())
    return;
  // One WebSocket frame can arrive in several events when it exceeds
  // buffer_size; payload_offset > 0 marks the continuation pieces.
  const auto *bytes = reinterpret_cast<const uint8_t *>(data->data_ptr);
  size_t len = data->data_len;
  if (data->payload_offset == 0) {
    if (data->op_code == WS_TRANSPORT_OPCODES_BINARY) {
      this->frame_is_text_ = false;
      this->frame_kind_ = len > 0 ? bytes[0] : 0;
      bytes += 1;
      len = len > 0 ? len - 1 : 0;
    } else if (data->op_code == WS_TRANSPORT_OPCODES_TEXT) {
      this->frame_is_text_ = true;
      this->text_frame_.clear();
    } else {
      return;  // ping, pong, close: handled by the client
    }
  }

  if (this->frame_is_text_) {
    this->text_frame_.append(reinterpret_cast<const char *>(bytes), len);
    if (data->payload_offset + data->data_len >= data->payload_len)
      this->on_control_(generation, this->text_frame_);
    return;
  }
  if (this->frame_kind_ == protocol::KIND_AUDIO && len > 0) {
    if (this->playback_->write_without_replacement(bytes, len, 0) < len)
      ESP_LOGW(TAG, "playback buffer full, dropped audio");
  }
}

void VoiceBroker::on_control_(uint32_t generation, const std::string &text) {
  json::parse_json(text, [&](JsonObject root) -> bool {
    const char *type = root["type"];
    if (type == nullptr)
      return false;
    if (std::strcmp(type, protocol::END) == 0) {
      this->post_event_(Event::END, generation);
    } else if (std::strcmp(type, protocol::PHASE) == 0) {
      const char *phase = root["phase"];
      if (phase == nullptr)
        return false;
      if (std::strcmp(phase, "listening") == 0) {
        this->post_event_(Event::PHASE, generation, Phase::LISTENING);
      } else if (std::strcmp(phase, "thinking") == 0) {
        this->post_event_(Event::PHASE, generation, Phase::THINKING);
      } else if (std::strcmp(phase, "replying") == 0) {
        this->post_event_(Event::PHASE, generation, Phase::REPLYING);
      }
    } else {
      ESP_LOGW(TAG, "Unknown control message: %s", type);
    }
    return true;
  });
}

}  // namespace esphome::voice_broker
