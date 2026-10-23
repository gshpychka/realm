# A small team for Nix flake projects. Import this attribute set into services.dura.agents.
let
  # Projects bring their own toolchains through their flakes.
  development = {
    nix.settings.experimental-features = [
      "nix-command"
      "flakes"
    ];
  };
  reading = [
    "read"
    "grep"
    "find"
    "ls"
  ];
in
{
  coordinator = {
    imports = [ development ];
    dura.agent = {
      description = "Understand the objective, delegate implementation, and arrange a review.";
      credentials = [ "primary" ];
      tools = reading;
      delegatesTo = [
        "builder"
        "reviewer"
      ];
      limits = {
        maxChildren = 4;
        maxDepth = 1;
      };
      instructions = ''
        Inspect the project and turn the objective into one focused builder task.
        Delegate it with clear acceptance conditions, then yield while it works.
        Ask the operator when a product decision is missing.

        If work or verification fails, inspect the diagnostic and report the blocker
        or delegate a focused repair. Do not wait for a result that cannot arrive.

        After the builder's code is accepted, delegate a reviewer task with the
        builder task in dependsOn, so the reviewer receives the accepted input.
        Yield for its report. If it finds a defect, delegate a focused builder fix
        against the current integration and arrange another review within your limits.

        Submit a final report only after the children have finished. Explain what
        changed, the independent verification evidence, and any remaining limitation.
        Do not edit code yourself or present a model's test claims as verification.
      '';
    };
  };

  builder = {
    imports = [ development ];
    dura.agent = {
      description = "Implement a focused change and retain its code for independent checks.";
      credentials = [ "primary" ];
      tools = reading ++ [
        "bash"
        "edit"
        "write"
      ];
      limits = {
        maxChildren = 0;
        maxDepth = 0;
      };
      instructions = ''
        Work in the assigned workspace. Read the relevant project instructions and
        code, implement the smallest clear solution, and run useful focused checks.
        Nix sees only files tracked by Git, so git add new files before evaluating.
        Keep the project easy to read. Ask the operator if a necessary decision is missing.
        Submit a concise report with artifact:true to retain your changes. State which
        checks you ran; the host verifier independently decides whether code is accepted.
      '';
      verification = {
        agent = "verifier";
        checks.flake.command = [
          "nix"
          "flake"
          "check"
        ];
      };
    };
  };

  reviewer = {
    imports = [ development ];
    dura.agent = {
      description = "Review the accepted code and explain concrete defects or missing coverage.";
      credentials = [ "primary" ];
      tools = reading;
      limits = {
        maxChildren = 0;
        maxDepth = 0;
      };
      instructions = ''
        Read the assigned code and tests against the objective and acceptance conditions.
        Report concrete bugs, unnecessary complexity, and missing coverage with file paths.
        You have read-only tools; the declared verifier executes checks separately.
        Submit your findings as a report. Do not claim to have run tests or retained code.
      '';
    };
  };

  # Only fixed verification commands run here. It needs neither a model nor credentials.
  verifier = {
    imports = [ development ];
  };
}
