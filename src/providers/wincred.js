'use strict';

/**
 * Reads a Windows Credential Manager *generic* credential (the store Go's
 * keyring package uses on Windows) and returns its blob as UTF-8 text.
 *
 * There is no pure-Node way to call CredRead, so we spawn powershell with a
 * self-contained P/Invoke script via -EncodedCommand. The script is static —
 * only the target name is interpolated.
 */

const { spawn } = require('child_process');

const PS_TEMPLATE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CredWin {
  [StructLayout(LayoutKind.Sequential)]
  private struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (c.CredentialBlobSize <= 0) return null;
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return System.Text.Encoding.UTF8.GetString(b);
    } finally { CredFree(ptr); }
  }
}
"@
$value = [CredWin]::Read($env:CODENOTCH_CRED_TARGET)
if ($null -eq $value) { Write-Output '__NOTFOUND__'; exit 0 }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output $value
`;

function run(target) {
  return new Promise((resolve) => {
    const script = PS_TEMPLATE.replace(
      /\$env:CODENOTCH_CRED_TARGET/g,
      `'${String(target).replace(/'/g, "''")}'`
    );
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let done = false;
    let timer = null;
    const settle = (value, ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (!ok) console.warn(`[wincred] CredRead for "${target}" failed`);
      resolve(value);
    };
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (err) => {
      console.warn('[wincred] powershell spawn failed:', err && err.message);
      settle(null, false);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[wincred] CredRead for "${target}" exited ${code}`);
        return settle(null, false);
      }
      const value = out.replace(/^\uFEFF/, '').trim();
      settle(value === '__NOTFOUND__' || !value ? null : value, true);
    });
    timer = setTimeout(() => {
      console.warn(`[wincred] CredRead for "${target}" timed out after 15s`);
      try {
        child.kill();
      } catch {
        /* gone */
      }
      settle(null, false);
    }, 15000);
  });
}

module.exports = { readCredentialManager: run };
