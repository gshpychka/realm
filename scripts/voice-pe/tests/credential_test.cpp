#include "credential.h"

#include <gtest/gtest.h>

#include <string>
#include <vector>

namespace esphome::voice_broker {
namespace {

TEST(Credential, OnlyAHeaderSafeTokenIsValid) {
  EXPECT_TRUE(Credential::valid(""));
  EXPECT_TRUE(Credential::valid(std::string(Credential::MAX_SIZE, '~')));
  for (const std::string &token : {std::string(Credential::MAX_SIZE + 1, 'a'), std::string("a b"),
                                  std::string("a\r\nX-Injected: 1"), std::string("a\tb"), std::string("a\x7f"),
                                  std::string("caf\xc3\xa9"), std::string("a\0b", 3)})
    EXPECT_FALSE(Credential::valid(token)) << token;
}

TEST(Credential, ATokenIsAdoptedOnlyOnceStored) {
  Credential credential;
  std::vector<std::string> stored;
  const auto store = [&](const std::string &token) {
    stored.push_back(token);
    return true;
  };
  ASSERT_TRUE(credential.replace("old", store));

  EXPECT_FALSE(credential.replace("new", [](const std::string &) { return false; }));
  EXPECT_FALSE(credential.replace(std::string(Credential::MAX_SIZE + 1, 'a'), store));
  EXPECT_EQ(credential.get(), "old");
  EXPECT_EQ(stored, std::vector<std::string>{"old"});

  EXPECT_TRUE(credential.replace("", store));
  EXPECT_EQ(credential.get(), "");
}

}  // namespace
}  // namespace esphome::voice_broker
