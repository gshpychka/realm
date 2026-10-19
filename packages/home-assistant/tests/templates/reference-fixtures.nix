# Each case is emitted through the public constructor and rendered by pinned HA.
[
  {
    path = [ "end_ts" ];
    output = "integer";
    variables.end_ts = 42;
    expected = 42;
  }
  {
    path = [
      "trigger"
      "id"
    ];
    output = "text";
    variables.trigger.id = "room";
    expected = "room";
  }
  {
    path = [
      "response"
      "nested"
      "enabled"
    ];
    output = "boolean";
    variables.response.nested.enabled = true;
    expected = true;
  }
  {
    path = [
      "response"
      "value"
    ];
    output = "number";
    variables.response.value = 2.5;
    expected = 2.5;
  }
  {
    path = [
      "response"
      "value"
    ];
    output = "mapping";
    variables.response.value = {
      enabled = true;
    };
    expected = {
      enabled = true;
    };
  }
  {
    path = [
      "response"
      "value"
    ];
    output = "list";
    variables.response.value = [
      1
      false
      null
    ];
    expected = [
      1
      false
      null
    ];
  }
  {
    path = [
      "response"
      "value"
    ];
    output = "nullable-text";
    variables.response.value = null;
    expected = null;
  }
  {
    path = [
      "_response2"
      "_field3"
    ];
    output = "text";
    variables._response2._field3 = "quoted ' \" \\ Україна";
    expected = "quoted ' \" \\ Україна";
  }
  {
    path = [
      "trigger"
      "if"
    ];
    output = "text";
    variables.trigger."if" = "keyword attribute";
    expected = "keyword attribute";
  }
]
