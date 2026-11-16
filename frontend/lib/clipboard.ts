/**
 * Clipboard writes can be rejected (permissions, non-secure context), so the
 * legacy textarea path is kept as a fallback for the copy-to-Excel workflow.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const succeeded = document.execCommand("copy");
    document.body.removeChild(area);
    return succeeded;
  } catch {
    return false;
  }
}
