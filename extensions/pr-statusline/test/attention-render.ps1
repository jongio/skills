param(
    [Parameter(Mandatory = $true)][string] $Executable,
    [Parameter(Mandatory = $true)][uint32] $OwnerProcessId
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AttentionPixels {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr context);
    [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr context, int x, int y);
    [DllImport("dwmapi.dll")] public static extern int DwmFlush();
    public static bool IsTargetPoint(IntPtr target, int x, int y) {
        var old = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            var point = new Point { X=x, Y=y };
            if(MonitorFromPoint(point,0) == IntPtr.Zero) return false;
            var under = WindowFromPoint(point);
            return under == target || GetAncestor(under,3) == target;
        } finally { if(old != IntPtr.Zero) SetThreadDpiAwarenessContext(old); }
    }
    public static uint Sample(int x, int y) {
        var old = SetThreadDpiAwarenessContext(new IntPtr(-4));
        var context = IntPtr.Zero;
        try {
            DwmFlush();
            context = GetDC(IntPtr.Zero);
            return context == IntPtr.Zero ? uint.MaxValue : GetPixel(context,x,y);
        } finally {
            if(context != IntPtr.Zero) ReleaseDC(IntPtr.Zero,context);
            if(old != IntPtr.Zero) SetThreadDpiAwarenessContext(old);
        }
    }
}
'@

$assembly = [Reflection.Assembly]::LoadFile($Executable)
$type = $assembly.GetType('TerminalAttention', $true)
$flags = [Reflection.BindingFlags]'Static, NonPublic'
function Call([string] $name, [object[]] $arguments = @()) {
    $type.GetMethod($name, $flags).Invoke($null, $arguments)
}
function AssertPixel([uint32] $actual, [uint32] $expected, [string] $label) {
    if ($actual -eq [uint32]::MaxValue) {
        throw [NotSupportedException]::new('Desktop pixel capture is unavailable at the current sample.')
    }
    foreach ($shift in @(0, 8, 16)) {
        if ([Math]::Abs((($actual -shr $shift) -band 255) - (($expected -shr $shift) -band 255)) -gt 8) {
            throw "$label was not rendered: expected 0x$($expected.ToString('X6')), observed 0x$($actual.ToString('X6'))."
        }
    }
}
function Pump {
    $messageType = $type.GetNestedType('Message', [Reflection.BindingFlags]::NonPublic)
    $message = [Activator]::CreateInstance($messageType)
    $peek = $type.GetMethod('PeekMessage', $flags)
    $arguments = [object[]]@($message, [IntPtr]::Zero, [uint32]0, [uint32]0, [uint32]1)
    while ($peek.Invoke($null, $arguments)) {
        [void](Call 'TranslateMessage' @($arguments[0]))
        [void](Call 'DispatchMessage' @($arguments[0]))
    }
}
function IsTargetPoint([int] $x, [int] $y) {
    return [AttentionPixels]::IsTargetPoint($target, $x, $y)
}

try {
    Call 'Bind' @($OwnerProcessId)
    $target = $type.GetField('target', $flags).GetValue($null)
    Call 'Initialize'
    $bounds = Call 'Bounds'
    $sample = $null
    foreach ($offset in @(60, [int]($bounds.Height / 2), ($bounds.Height - 60))) {
        $y = $bounds.Top + [Math]::Max(10, [Math]::Min($bounds.Height - 10, $offset))
        foreach ($side in @('left', 'right')) {
            $borderX = if ($side -eq 'left') { $bounds.Left + 3 } else { $bounds.Right - 4 }
            $fillX = if ($side -eq 'left') { $bounds.Left + 30 } else { $bounds.Right - 30 }
            if ((IsTargetPoint $borderX $y) -and (IsTargetPoint $fillX $y)) {
                $sample = @{ BorderX = $borderX; FillX = $fillX; Y = $y }
                break
            }
        }
        if ($null -ne $sample) { break }
    }
    if ($null -eq $sample) {
        @{
            type = 'renderTest'
            visible = $false
            reason = "No visible border/background sample in bound Terminal $($target.ToInt64()) at ($($bounds.Left),$($bounds.Top))."
        } | ConvertTo-Json -Compress
        return
    }
    $borderX = $sample.BorderX
    $fillX = $sample.FillX
    $y = $sample.Y
    $foreground = [AttentionPixels]::GetForegroundWindow()
    foreach ($mode in @('border', 'background', 'both')) {
        Call 'Hide'
        [void][AttentionPixels]::DwmFlush()
        $baseline = [AttentionPixels]::Sample($fillX, $y)
        if ($baseline -eq [uint32]::MaxValue) {
            throw [NotSupportedException]::new('Desktop pixel capture is unavailable at the current sample.')
        }
        Call 'Render' @($mode, '#FFBB24', [double]0.5)
        Pump
        Start-Sleep -Milliseconds 150
        if ([AttentionPixels]::GetForegroundWindow() -ne $foreground) { throw "$mode stole foreground focus." }
        if ($mode -ne 'background') {
            AssertPixel ([AttentionPixels]::Sample($borderX, $y)) 0x0024BBFF "$mode border"
        }
        if ($mode -ne 'border') {
            $expected = [uint32]0
            foreach ($shift in @(0, 8, 16)) {
                $base = ($baseline -shr $shift) -band 255
                $overlay = (0x0024BBFF -shr $shift) -band 255
                $channel = [uint32][Math]::Round(($base * 195 + $overlay * 60) / 255)
                $expected = $expected -bor ($channel -shl $shift)
            }
            AssertPixel ([AttentionPixels]::Sample($fillX, $y)) $expected "$mode background"
        }
    }
    Call 'Render' @('border', '#B48CFF', [double]0.5)
    Pump
    Start-Sleep -Milliseconds 150
    AssertPixel ([AttentionPixels]::Sample($borderX, $y)) 0x00FF8CB4 'Updated question color'
    '{"type":"renderTest","visible":true,"passed":true}'
} catch [NotSupportedException] {
    @{ type = 'renderTest'; visible = $false; reason = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
    Call 'Cleanup'
}
