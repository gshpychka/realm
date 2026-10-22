"""Run with python3 -m unittest discover -s tests -p 'test_kodi_*.py'."""

import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class Hdr10PlusPickerTests(unittest.TestCase):
    def setUp(self):
        test = self
        self.events = []
        self.selection = -1

        class Player:
            def isPlayingVideo(self):
                return True

            def isPlaying(self):
                return False

            def getPlayingFile(self):
                return "smb://media/hybrid.mkv"

            def getPlayingItem(self):
                return types.SimpleNamespace(
                    setProperty=lambda key, value: test.events.append((key, value))
                )

            def getTime(self):
                return 125.5

            def stop(self):
                test.events.append("stop")
                self.onPlayBackStopped()

            def play(self, path, item):
                test.events.append("play")
                self.onAVStarted()

        kodi = types.SimpleNamespace(
            Player=Player,
            executeJSONRPC=self.execute_rpc,
            getCondVisibility=self.condition,
            getInfoLabel=lambda label: (
                "HDR10+" if "additional" in label else "Dolby Vision"
            ),
            Monitor=lambda: types.SimpleNamespace(waitForAbort=lambda timeout: False),
        )
        gui = types.SimpleNamespace(
            Dialog=lambda: types.SimpleNamespace(
                select=lambda heading, choices, preselect: self.selection,
                notification=lambda *args, **kwargs: None,
            )
        )
        source = Path(__file__).resolve().parents[1] / "scripts/kodi/kodi-hdr10plus.py"
        spec = importlib.util.spec_from_file_location(
            "kodi_hdr10plus_test_target", source
        )
        self.picker = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"xbmc": kodi, "xbmcgui": gui}):
            spec.loader.exec_module(self.picker)
        self.modes = [
            {
                self.picker.CONVERT: False,
                self.picker.PRIORITY: 1,
                self.picker.PREFER: False,
            },
            {
                self.picker.CONVERT: True,
                self.picker.PRIORITY: 0,
                self.picker.PREFER: False,
            },
            {
                self.picker.CONVERT: True,
                self.picker.PRIORITY: 0,
                self.picker.PREFER: True,
            },
        ]
        self.state = self.modes[0].copy()

    def condition(self, expression):
        if expression.startswith("System.GetBool("):
            return self.state[expression[len("System.GetBool(") : -1]]
        return expression == "Player.Paused"

    def visible(self, setting):
        if setting == self.picker.CONVERT:
            return self.state[self.picker.PRIORITY] == 0
        if setting == self.picker.PREFER:
            return (
                self.state[self.picker.PRIORITY] == 0
                and self.state[self.picker.CONVERT]
            )
        return True

    def execute_rpc(self, raw):
        request = json.loads(raw)
        method, params = request["method"], request["params"]
        if method == "Settings.GetSettingValue":
            # Kodi checks visibility on reads, as well as writes. In native
            # mode, reading conversion/preference over JSON-RPC fails.
            if not self.visible(params["setting"]):
                return json.dumps(
                    {"error": {"code": -32602, "message": "Invalid params."}}
                )
            result = {"value": self.state[params["setting"]]}
        elif method == "Settings.SetSettingValue":
            result = self.visible(params["setting"])
            if result:
                self.events.append("setting")
                self.state[params["setting"]] = params["value"]
        elif method == "Player.GetProperties":
            result = {
                "currentaudiostream": {"index": 0},
                "currentsubtitle": None,
                "subtitleenabled": False,
            }
        elif method in (
            "Player.SetAudioStream",
            "Player.SetSubtitle",
            "Player.PlayPause",
        ):
            self.events.append((method, params))
            result = "OK"
        else:
            raise AssertionError(f"Unexpected RPC: {method}")
        return json.dumps({"result": result})

    def test_all_mode_transitions_with_hidden_settings(self):
        for start in range(3):
            for target in range(3):
                with self.subTest(start=start, target=target):
                    self.state = self.modes[start].copy()
                    self.selection = target
                    self.events.clear()
                    self.picker.select_mapping()
                    self.assertEqual(self.state, self.modes[target])
                    if start == target:
                        self.assertEqual(self.events, [])
                    else:
                        self.assertLess(
                            self.events.index("stop"), self.events.index("play")
                        )
                        self.assertIn(("StartOffset", "125.5"), self.events)
                        self.assertIn(
                            ("Player.PlayPause", {"playerid": 1, "play": False}),
                            self.events,
                        )

    def test_cancel_from_native_mode_preserves_settings_and_playback(self):
        self.picker.select_mapping()
        self.assertEqual(self.state, self.modes[0])
        self.assertEqual(self.events, [])


if __name__ == "__main__":
    unittest.main()
