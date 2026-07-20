/**
 * テキスト入力モーダル。
 * Electron のレンダラーは window.prompt() を非サポートのため、その代替。
 */

export function showInputDialog(title, defaultValue = "") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";

    const box = document.createElement("div");
    box.className = "dialog-box";

    const h = document.createElement("div");
    h.className = "dialog-title";
    h.textContent = title;

    const input = document.createElement("input");
    input.type = "text";
    input.value = defaultValue;

    const row = document.createElement("div");
    row.className = "dialog-buttons";
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = "OK";
    const cancel = document.createElement("button");
    cancel.textContent = "キャンセル";
    row.append(cancel, ok);

    box.append(h, input, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (value) => {
      overlay.remove();
      resolve(value);
    };

    ok.addEventListener("click", () => close(input.value));
    cancel.addEventListener("click", () => close(null));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") close(input.value);
      else if (e.key === "Escape") close(null);
    });

    input.focus();
    input.select();
  });
}
