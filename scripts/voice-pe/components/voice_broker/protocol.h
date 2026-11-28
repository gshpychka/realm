#pragma once

// Wire protocol shared with the broker. The authoritative description is the
// docstring of packages/voice-broker/src/voice_broker/protocol.py; keep
// these constants in sync with it.

#include <cstddef>
#include <cstdint>

namespace esphome::voice_broker::protocol {

static constexpr uint32_t MIC_RATE = 16000;
static constexpr uint32_t SPEAKER_RATE = 24000;

enum Kind : uint8_t {
  KIND_MIC = 0x01,     // u32 first_sample, i64 capture_us, PCM16 @ MIC_RATE
  KIND_PLAYED = 0x02,  // u32 frames, i64 dac_us
  KIND_AUDIO = 0x81,   // PCM16 @ SPEAKER_RATE
};

static constexpr size_t MIC_HEADER_SIZE = 1 + 4 + 8;
static constexpr size_t PLAYED_SIZE = 1 + 4 + 8;

// Control frames are JSON objects with a "type" field.
static constexpr const char *START = "start";
static constexpr const char *STOP = "stop";
static constexpr const char *ADMITTED = "admitted";
static constexpr const char *SUPPRESSED = "suppressed";
static constexpr const char *PHASE = "phase";
static constexpr const char *END = "end";

inline void put_u32(uint8_t *p, uint32_t v) {
  for (int i = 0; i < 4; i++)
    p[i] = static_cast<uint8_t>(v >> (8 * i));
}

inline void put_i64(uint8_t *p, int64_t v) {
  auto u = static_cast<uint64_t>(v);
  for (int i = 0; i < 8; i++)
    p[i] = static_cast<uint8_t>(u >> (8 * i));
}

}  // namespace esphome::voice_broker::protocol
