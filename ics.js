/* ics.js — iCalendar helpers.
 *  - ICS.generate(events): build a .ics string (for importing reviews into Google Calendar)
 *  - ICS.parse(text): parse VEVENTs out of a Blackbaud (or any) .ics feed
 *  - ICS.gcalLink(event): build an "Add to Google Calendar" template URL
 * Exposed on the global `ICS` object (no modules, so it works on file:// too).
 */
(function (global) {
  'use strict';

  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function pad(n) { return String(n).padStart(2, '0'); }

  // "2026-05-29" + "18:00" -> Date in local time
  function localDateTime(dateStr, timeStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    let hh = 9, mm = 0;
    if (timeStr && /^\d{1,2}:\d{2}$/.test(timeStr)) {
      [hh, mm] = timeStr.split(':').map(Number);
    }
    return new Date(y, m - 1, d, hh, mm, 0, 0);
  }

  // Local Date -> "YYYYMMDDTHHMMSS" (floating, paired with TZID)
  function fmtLocal(dt) {
    return (
      dt.getFullYear() + pad(dt.getMonth() + 1) + pad(dt.getDate()) +
      'T' + pad(dt.getHours()) + pad(dt.getMinutes()) + '00'
    );
  }

  function fmtUTC(dt) {
    return (
      dt.getUTCFullYear() + pad(dt.getUTCMonth() + 1) + pad(dt.getUTCDate()) +
      'T' + pad(dt.getUTCHours()) + pad(dt.getUTCMinutes()) + pad(dt.getUTCSeconds()) + 'Z'
    );
  }

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  // Fold long lines to 75 octets per RFC 5545 (approximate by characters).
  function fold(line) {
    if (line.length <= 73) return line;
    const out = [];
    let i = 0;
    out.push(line.slice(0, 73));
    i = 73;
    while (i < line.length) {
      out.push(' ' + line.slice(i, i + 72));
      i += 72;
    }
    return out.join('\r\n');
  }

  /* events: [{ uid, title, description, date:'YYYY-MM-DD', time:'HH:MM',
   *            durationMin, alarmMin }] */
  function generate(events, opts) {
    opts = opts || {};
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Recall//Spaced Repetition Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:' + escapeText(opts.calName || 'Recall Reviews'),
    ];
    const stamp = fmtUTC(new Date());
    for (const ev of events) {
      const start = localDateTime(ev.date, ev.time);
      const durMin = ev.durationMin || 30;
      const end = new Date(start.getTime() + durMin * 60000);
      const alarm = ev.alarmMin == null ? 0 : ev.alarmMin;
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + (ev.uid || (Date.now() + '-' + Math.random().toString(36).slice(2)) + '@recall'));
      lines.push('DTSTAMP:' + stamp);
      lines.push('DTSTART;TZID=' + TZ + ':' + fmtLocal(start));
      lines.push('DTEND;TZID=' + TZ + ':' + fmtLocal(end));
      lines.push(fold('SUMMARY:' + escapeText(ev.title)));
      if (ev.description) lines.push(fold('DESCRIPTION:' + escapeText(ev.description)));
      // VALARM so importing into Google Calendar yields a phone notification.
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push('DESCRIPTION:' + escapeText(ev.title));
      lines.push('TRIGGER:-PT' + alarm + 'M');
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  // Build a Google Calendar "create event" URL (opens prefilled in a new tab).
  function gcalLink(ev) {
    const start = localDateTime(ev.date, ev.time);
    const end = new Date(start.getTime() + (ev.durationMin || 30) * 60000);
    const dates = fmtLocal(start) + '/' + fmtLocal(end);
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: ev.title || 'Review',
      dates: dates,
      ctz: TZ,
    });
    if (ev.description) params.set('details', ev.description);
    return 'https://calendar.google.com/calendar/render?' + params.toString();
  }

  // ---- Parsing (Blackbaud / generic .ics) ----

  function unfold(text) {
    // Join folded lines (continuation lines start with space or tab).
    return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  }

  function parseICSDate(val, params) {
    // params like ";VALUE=DATE" or ";TZID=America/New_York"
    const isDateOnly = /VALUE=DATE(?!-TIME)/i.test(params || '');
    let m;
    if (isDateOnly && (m = val.match(/^(\d{4})(\d{2})(\d{2})$/))) {
      return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null, allDay: true };
    }
    if ((m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/))) {
      if (m[7] === 'Z') {
        // UTC -> convert to local
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
        const pad = (n) => String(n).padStart(2, '0');
        return {
          date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
          time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
          allDay: false,
        };
      }
      // Floating / TZID local time — treat the wall-clock values as-is.
      return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, allDay: false };
    }
    if ((m = val.match(/^(\d{4})(\d{2})(\d{2})$/))) {
      return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null, allDay: true };
    }
    return null;
  }

  function unescapeText(s) {
    return String(s || '')
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  function parse(text) {
    const out = [];
    const unfolded = unfold(text || '');
    const blocks = unfolded.split(/BEGIN:VEVENT/i).slice(1);
    for (const block of blocks) {
      const body = block.split(/END:VEVENT/i)[0];
      const lines = body.split('\n');
      const ev = {};
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const left = line.slice(0, idx);
        const value = line.slice(idx + 1).trim();
        const name = left.split(';')[0].toUpperCase();
        const params = left.slice(name.length);
        if (name === 'SUMMARY') ev.title = unescapeText(value);
        else if (name === 'DESCRIPTION') ev.description = unescapeText(value);
        else if (name === 'UID') ev.uid = value;
        else if (name === 'LOCATION') ev.location = unescapeText(value);
        else if (name === 'DTSTART') {
          const d = parseICSDate(value, params);
          if (d) { ev.date = d.date; ev.time = d.time; ev.allDay = d.allDay; }
        }
      }
      if (ev.date && ev.title) out.push(ev);
    }
    return out;
  }

  global.ICS = { generate, gcalLink, parse, TZ };
})(window);
