import type { CompetitorFormField } from "./recreateChrome";
import type { BlueprintForm } from "./blueprint";

/**
 * The lead form, rebuilt from the competitor's captured fields with the
 * page's shared form classes. Submissions are validated and answered with a
 * thank-you message; setting data-endpoint on the form posts them as JSON.
 */

export type LeadFormCopy = {
  submitLabel?: string | null;
  successMessage?: string | null;
  /** Fields proposed for steps the competitor page only names (rendered one step at a time). */
  stepFields?: Record<string, CompetitorFormField[]>;
  /** Short note under the button ("No obligation…"). */
  note?: string | null;
  /** Consent line for the client, when the competitor asked for consent. */
  consentLabel?: string | null;
};

export const LEAD_FORM_ID = "adr-lead-form";
export const FORM_SLOT_ATTR = "data-adrival-form";

function esc(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slug(value: string, fallback: string): string {
  const s = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || fallback;
}

function autocompleteFor(field: CompetitorFormField): string {
  const hay = `${field.label} ${field.name}`.toLowerCase();
  if (/first/.test(hay)) return "given-name";
  if (/last|surname/.test(hay)) return "family-name";
  if (field.type === "email") return "email";
  if (field.type === "tel") return "tel";
  if (field.type === "url") return "url";
  if (/company|business name|organi/.test(hay)) return "organization";
  if (/\bname\b/.test(hay)) return "name";
  return "off";
}

function wide(field: CompetitorFormField): boolean {
  return field.type === "textarea" || field.type === "radio" || field.type === "checkbox";
}

/**
 * A placeholder shows an example, never a copy of the label (Vercel forms):
 * "Company Website* (e.g. example.com)" becomes "e.g. example.com", and
 * "Email*" under an "Email" label is dropped.
 */
export function placeholderHint(field: Pick<CompetitorFormField, "label" | "placeholder">): string | null {
  const raw = (field.placeholder || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const example = raw.match(/\((e\.g\.|eg|for example|like)\s*([^)]+)\)/i);
  if (example) return `e.g. ${example[2].trim()}`;
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const label = norm(field.label || "");
  const text = norm(raw);
  // The same words as the label (or a shorter/longer form of it) add nothing.
  if (!text) return null;
  if (label && (text === label || label.includes(text) || text.includes(label))) return null;
  return raw;
}

function fieldHtml(field: CompetitorFormField, index: number, formId: string): string {
  const name = slug(field.name || field.label, `field_${index + 1}`);
  const id = `${formId}-${name}`;
  const req = field.required ? " required" : "";
  const star = field.required ? `<span class="adr-req" aria-hidden="true">*</span>` : "";
  const label = esc(field.label || "Your answer");
  // Label text and its required mark stay on one line above the control.
  const caption = `<span class="adr-field-label">${label}${star}</span>`;
  const cls = `adr-field${wide(field) ? " adr-field--wide" : ""}`;
  const hint = placeholderHint(field);
  const placeholder = hint ? ` placeholder="${esc(hint)}"` : "";
  if (field.type === "textarea") {
    return `<label class="${cls}" for="${id}">${caption}<textarea id="${id}" name="${name}" rows="4"${req}${placeholder}></textarea></label>`;
  }
  if (field.type === "select") {
    const options = field.options?.length ? field.options : [];
    const first = `<option value="" disabled selected>${esc(field.placeholder || "Select…")}</option>`;
    return `<label class="${cls}" for="${id}">${caption}<select id="${id}" name="${name}"${req}>${first}${options
      .map((o) => `<option>${esc(o)}</option>`)
      .join("")}</select></label>`;
  }
  if ((field.type === "radio" || field.type === "checkbox") && (field.options?.length || 0) >= 2) {
    const type = field.type;
    return `<fieldset class="${cls}"><legend class="adr-field-legend">${label}${star}</legend><div class="adr-choice">${field.options!
      .map((o, i) => `<label><input type="${type}" name="${name}" value="${esc(o)}"${req && type === "radio" && i === 0 ? " required" : ""}> ${esc(o)}</label>`)
      .join("")}</div></fieldset>`;
  }
  if (field.type === "checkbox" || field.type === "radio") {
    return `<label class="adr-check adr-field--wide"><input type="checkbox" name="${name}"${req}> <span>${label}</span></label>`;
  }
  const type = ["email", "tel", "url", "number"].includes(field.type) ? field.type : "text";
  return `<label class="${cls}" for="${id}">${caption}<input id="${id}" name="${name}" type="${type}" autocomplete="${autocompleteFor(field)}"${req}${placeholder}></label>`;
}

function gridOf(fields: CompetitorFormField[], formId: string, twoColumn: boolean, offset = 0): string {
  const inner = fields.map((f, i) => fieldHtml(f, i + offset, formId)).join("\n");
  return twoColumn ? `<div class="adr-form-grid">${inner}</div>` : inner;
}

/** Fields for a booking widget the page embedded (Calendly and similar). */
const BOOKING_FIELDS: CompetitorFormField[] = [
  { label: "Full name", name: "name", type: "text", required: true },
  { label: "Email", name: "email", type: "email", required: true },
  { label: "Phone", name: "phone", type: "tel", required: false },
  { label: "Best time to talk", name: "best_time", type: "select", required: false, options: ["Morning", "Midday", "Afternoon"] },
];

export function buildLeadFormHtml(form: BlueprintForm, copy: LeadFormCopy = {}): { html: string; notes: string[] } {
  const notes: string[] = [];
  const formId = LEAD_FORM_ID;
  let fields = form.booking && form.fields.length < 2 ? BOOKING_FIELDS : form.fields;
  if (!fields.length) {
    fields = BOOKING_FIELDS.slice(0, 3);
    notes.push("The competitor's form could not be read, so a short contact form was used.");
  }
  if (form.booking) notes.push("The competitor used a booking widget; it was rebuilt as a booking request form.");
  const twoColumn = form.layout === "two-column" || (form.style?.perRow || 1) >= 2;
  const submit = esc((copy.submitLabel || form.submitLabel || "Submit").replace(/\s+/g, " ").trim());
  const byKey = new Map(fields.map((f) => [f.name, f]));
  const byLabel = new Map(fields.map((f) => [f.label, f]));
  const pick = (keys: string[]) =>
    keys.map((k) => byKey.get(k) || byKey.get(k.replace(/[^a-z0-9_-]+/gi, "_")) || byLabel.get(k)).filter((f): f is CompetitorFormField => Boolean(f));

  let body = "";
  let offset = 0;
  if (form.mode === "multi-step" && form.steps.length >= 2) {
    const steps = form.steps
      .map((step) => {
        let stepFields = pick(step.fields);
        if (!stepFields.length && step.title && copy.stepFields?.[step.title]?.length) {
          stepFields = copy.stepFields[step.title];
          notes.push(`Fields for step "${step.title}" were proposed for your business (the competitor only shows that step after the first).`);
        }
        return { title: step.title, fields: stepFields };
      })
      .filter((step) => step.fields.length);
    const used = new Set(steps.flatMap((s) => s.fields));
    const leftover = fields.filter((f) => !used.has(f));
    if (leftover.length && steps.length) steps[steps.length - 1].fields.push(...leftover);
    if (steps.length >= 2) {
      const list = `<ol class="adr-form-steps" aria-label="Form steps">${steps
        .map((s, i) => `<li${i === 0 ? ' aria-current="step"' : ""}>${i + 1}. ${esc(s.title || `Step ${i + 1}`)}</li>`)
        .join("")}</ol>`;
      body =
        list +
        steps
          .map((s, i) => {
            const html = `<fieldset class="adr-form-step" data-step="${i + 1}"${i === 0 ? "" : " hidden"}><legend>${esc(s.title || `Step ${i + 1}`)}</legend>${gridOf(s.fields, formId, twoColumn, offset)}</fieldset>`;
            offset += s.fields.length;
            return html;
          })
          .join("\n") +
        `<div class="adr-form-nav"><button type="button" class="adr-btn adr-btn--secondary" data-form-back hidden>Back</button><button type="button" class="adr-btn adr-btn--primary" data-form-next>${esc(form.nextLabel && !/^next\b.*:/i.test(form.nextLabel) ? form.nextLabel : "Next")}</button><button type="submit" class="adr-btn adr-btn--primary" hidden>${submit}</button></div>`;
    }
  }
  if (!body && (form.mode === "grouped" || form.mode === "multi-step") && form.steps.length >= 2) {
    const groups = form.steps.map((s) => ({ title: s.title, fields: pick(s.fields) })).filter((g) => g.fields.length);
    const used = new Set(groups.flatMap((g) => g.fields));
    const leftover = fields.filter((f) => !used.has(f));
    if (leftover.length && groups.length) groups[groups.length - 1].fields.push(...leftover);
    if (groups.length >= 2) {
      body = groups
        .map((g) => {
          const html = `<fieldset>${g.title ? `<legend>${esc(g.title)}</legend>` : ""}${gridOf(g.fields, formId, twoColumn, offset)}</fieldset>`;
          offset += g.fields.length;
          return html;
        })
        .join("\n");
      body += `<button type="submit" class="adr-btn adr-btn--primary">${submit}</button>`;
    }
  }
  if (!body) {
    body = `${gridOf(fields, formId, twoColumn && fields.length >= 3)}<button type="submit" class="adr-btn adr-btn--primary">${submit}</button>`;
  }
  if (form.consent && !fields.some((f) => f.type === "checkbox" && /agree|consent|privacy|terms/i.test(f.label))) {
    body = body.replace(
      /(<button type="submit")/,
      `<label class="adr-check"><input type="checkbox" name="consent" required> <span>${esc(copy.consentLabel || "I agree to be contacted about my enquiry.")}</span></label>$1`,
    );
  }
  const note = copy.note ? `<p class="adr-form-note">${esc(copy.note)}</p>` : "";
  const success = esc(copy.successMessage || "Thanks — we have your details and will be in touch shortly.");
  const html = `<!-- AdRival lead form: add data-endpoint="https://…" to this form to send submissions (JSON POST) to your CRM or email tool. -->
<form id="${formId}" class="adr-form" data-adrival-lead-form data-endpoint="" novalidate>
${body}
${note}
<div class="adr-form-success" role="status" hidden>${success}</div>
</form>`;
  return { html, notes };
}

/** Behaviour for the lead form: validation, steps, submit. Plain JS, no dependencies. */
export const LEAD_FORM_SCRIPT = `<script data-adrival-form-runtime>
(function(){
  var form = document.querySelector('form[data-adrival-lead-form]');
  if (!form) return;
  var steps = Array.prototype.slice.call(form.querySelectorAll('.adr-form-step'));
  var markers = Array.prototype.slice.call(form.querySelectorAll('.adr-form-steps li'));
  var back = form.querySelector('[data-form-back]');
  var next = form.querySelector('[data-form-next]');
  var submit = form.querySelector('button[type=submit]');
  var current = 0;
  function fieldsIn(scope){ return Array.prototype.slice.call(scope.querySelectorAll('input,select,textarea')); }
  function valid(scope){
    var ok = true;
    fieldsIn(scope).forEach(function(el){
      var bad = !el.checkValidity();
      el.setAttribute('aria-invalid', bad ? 'true' : 'false');
      if (bad && ok) { ok = false; el.focus(); }
    });
    return ok;
  }
  function show(i){
    current = i;
    steps.forEach(function(s, k){ s.hidden = k !== i; });
    markers.forEach(function(m, k){ if (k === i) m.setAttribute('aria-current', 'step'); else m.removeAttribute('aria-current'); });
    if (back) back.hidden = i === 0;
    if (next) next.hidden = i === steps.length - 1;
    if (submit) submit.hidden = i !== steps.length - 1;
  }
  if (steps.length) {
    show(0);
    if (next) next.addEventListener('click', function(){ if (valid(steps[current])) show(Math.min(current + 1, steps.length - 1)); });
    if (back) back.addEventListener('click', function(){ show(Math.max(current - 1, 0)); });
  }
  form.addEventListener('submit', function(e){
    e.preventDefault();
    if (!valid(steps.length ? steps[current] : form)) return;
    var data = {};
    fieldsIn(form).forEach(function(el){
      if (!el.name) return;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
      data[el.name] = data[el.name] ? [].concat(data[el.name], el.value) : el.value;
    });
    var done = function(){
      Array.prototype.slice.call(form.children).forEach(function(c){ if (!c.classList.contains('adr-form-success')) c.hidden = true; });
      var msg = form.querySelector('.adr-form-success');
      if (msg) msg.hidden = false;
    };
    var endpoint = form.getAttribute('data-endpoint');
    if (endpoint) {
      fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(done, done);
    } else done();
  });
})();
</script>`;
