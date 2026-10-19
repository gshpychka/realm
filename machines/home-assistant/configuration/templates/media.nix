{
  slots = {
    output = "mapping";
    file = "media/slots.jinja";
  };
  raw_title = {
    output = "text";
    file = "media/raw-title.jinja";
  };
  raw_type = {
    output = "text";
    file = "media/raw-type.jinja";
  };
  media_kind = {
    output = "text";
    file = "media/media-kind.jinja";
  };
  clean_title = {
    output = "text";
    file = "media/clean-title.jinja";
  };
  reject_media = {
    output = "boolean";
    file = "media/reject-media.jinja";
  };
  unknown_media = {
    output = "boolean";
    file = "media/unknown-media.jinja";
  };
  classifier_prompt = {
    output = "text";
    file = "media/classifier-prompt.jinja";
  };
  classified_media = {
    output = "text";
    file = "media/classified-media.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
  unsure_media = {
    output = "text";
    file = "media/unsure-media.jinja";
  };
  movie_media = {
    output = "boolean";
    file = "media/movie-media.jinja";
  };
  title_case = {
    output = "text";
    file = "media/title-case.jinja";
  };
  show_media = {
    output = "boolean";
    file = "media/show-media.jinja";
  };
  confirmation_prompt = {
    output = "text";
    file = "media/confirmation-prompt.jinja";
  };
  media_confirmation = {
    output = "text";
    file = "media/media-confirmation.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
}
