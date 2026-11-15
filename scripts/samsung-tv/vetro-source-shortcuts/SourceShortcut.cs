// HDMI selection follows Vetro's dock/src/Program.cs (SwitchSource).
// The CEC call selects the child input behind the soundbar as well as the TV port.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

internal static class SourceShortcut
{
    private const string AppControl = "libcapi-appfw-app-control.so.0";
    [DllImport(AppControl)] private static extern int app_control_create(out IntPtr handle);
    [DllImport(AppControl)] private static extern int app_control_set_app_id(IntPtr handle, string appId);
    [DllImport(AppControl)] private static extern int app_control_add_extra_data(IntPtr handle, string key, string value);
    [DllImport(AppControl)] private static extern int app_control_send_launch_request(IntPtr handle, IntPtr callback, IntPtr data);
    [DllImport(AppControl)] private static extern int app_control_destroy(IntPtr handle);

    private static void Check(int result, string operation)
    {
        if (result != 0) throw new InvalidOperationException(operation + ": " + result);
    }

    private static void SelectDepth(int port, int depth)
    {
        var start = new ProcessStartInfo("/usr/bin/dbus-send",
            "--system --print-reply --reply-timeout=5000 --dest=org.tizen.tv.hdmicec " +
            "/org/tizen/tv/hdmicec org.tizen.tv.HdmiCec.SetDeviceStreamPathBySecondDepthHdmiPort " +
            "int32:" + port + " int32:" + depth);
        start.UseShellExecute = false;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using (var process = Process.Start(start))
        {
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException("CEC routing: " + error.Trim());
            foreach (var line in output.Split('\n'))
            {
                var value = line.Trim();
                if (!value.StartsWith("int32 ")) continue;
                Check(int.Parse(value.Substring(6)), "CEC routing");
                Console.WriteLine("CEC route: " + port + "." + depth + ".0.0");
                return;
            }
            throw new InvalidOperationException("CEC routing returned no result");
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            int source, depth;
            if (args.Length != 2 || !int.TryParse(args[0], out source) || source < 13 || source > 16 ||
                !int.TryParse(args[1], out depth) || depth < 0 || depth > 4)
                throw new ArgumentException("Expected HDMI source type 13..16 and soundbar input 0..4");
            var port = source - 12;
            var icon = "/usr/apps/com.samsung.tv.theme-resource/shared/res/org.tizen.menu/Settings_Popup/device_icon/r_icon_device_s_hdmi" + port + ".png";
            IntPtr handle;
            Check(app_control_create(out handle), "Create source request");
            try
            {
                Check(app_control_set_app_id(handle, "org.tizen.tv-viewer"), "Set viewer");
                Check(app_control_add_extra_data(handle, "change_source", source.ToString()), "Set source");
                Check(app_control_add_extra_data(handle, "sourceType", source.ToString()), "Set source type");
                // Samsung's viewer otherwise holds a full-screen source-name banner
                // for several seconds. This option still switches the input normally.
                Check(app_control_add_extra_data(handle, "sourceswitch_banner", "disable"), "Suppress source banner");
                Check(app_control_add_extra_data(handle, "sourceName", "HDMI" + port), "Set source name");
                Check(app_control_add_extra_data(handle, "sourceIcon", icon), "Set source icon");
                Check(app_control_add_extra_data(handle, "mbrIndex", "-2"), "Set device profile");
                Check(app_control_add_extra_data(handle, "__K_EX_LAUNCH_REQUESTOR", "user"), "Set requestor");
                Check(app_control_send_launch_request(handle, IntPtr.Zero, IntPtr.Zero), "Launch source");
            }
            finally { app_control_destroy(handle); }
            Thread.Sleep(500);
            if (depth != 0) SelectDepth(port, depth);
            Console.WriteLine("Selected HDMI" + port);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
