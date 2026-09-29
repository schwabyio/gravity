/**
 * Date formatting for `gta.date`: strftime over the specifiers xtest's `date()`
 * documented, in any time zone `Intl` knows.
 */

/** Format specifiers supported by `strftime`. */
const SPECIFIERS = 'YymdeHIMSpbBaAjZzsFTL%'

interface DateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
  offsetMinutes: number
  zoneName: string
}

/**
 * Break a date into calendar parts for a timezone.
 *
 * `Intl` is used rather than the `Date` getters so that `timezone` can be `utc`,
 * `local`, or any IANA zone name, all through one path.
 */
function partsIn(date: Date, timezone: string): DateParts {
  const zone =
    timezone.toLowerCase() === 'utc'
      ? 'UTC'
      : timezone.toLowerCase() === 'local'
        ? undefined
        : timezone

  const formatter = new Intl.DateTimeFormat('en-US', {
    ...(zone ? { timeZone: zone } : {}),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    timeZoneName: 'short'
  })

  const lookup: Record<string, string> = {}
  for (const part of formatter.formatToParts(date)) lookup[part.type] = part.value

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  // Intl gives hour 24 for midnight under hour12:false in some engines.
  const hour = Number(lookup['hour']) % 24

  return {
    year: Number(lookup['year']),
    month: Number(lookup['month']),
    day: Number(lookup['day']),
    hour,
    minute: Number(lookup['minute']),
    second: Number(lookup['second']),
    weekday: Math.max(0, weekdays.indexOf(lookup['weekday'] ?? 'Sun')),
    offsetMinutes: offsetMinutesIn(date, zone),
    zoneName: lookup['timeZoneName'] ?? 'UTC'
  }
}

function offsetMinutesIn(date: Date, zone: string | undefined): number {
  if (zone === undefined) return -date.getTimezoneOffset()
  const asUtc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }))
  const asZone = new Date(date.toLocaleString('en-US', { timeZone: zone }))
  return Math.round((asZone.getTime() - asUtc.getTime()) / 60000)
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/**
 * strftime over the specifiers xtest's `date()` documented.
 *
 * Deliberately a subset: an unknown specifier is left as written rather than
 * silently dropped, so a typo is visible in the output instead of vanishing.
 */
export function strftime(format: string, date: Date, timezone = 'local'): string {
  const p = partsIn(date, timezone)

  return format.replace(/%(.)/g, (whole, specifier: string) => {
    if (!SPECIFIERS.includes(specifier)) return whole
    switch (specifier) {
      case 'Y':
        return String(p.year)
      case 'y':
        return pad(p.year % 100)
      case 'm':
        return pad(p.month)
      case 'd':
        return pad(p.day)
      case 'e':
        return String(p.day).padStart(2, ' ')
      case 'H':
        return pad(p.hour)
      case 'I':
        return pad(p.hour % 12 === 0 ? 12 : p.hour % 12)
      case 'M':
        return pad(p.minute)
      case 'S':
        return pad(p.second)
      case 'L':
        return pad(date.getMilliseconds(), 3)
      case 'p':
        return p.hour < 12 ? 'AM' : 'PM'
      case 'b':
        return MONTHS[p.month - 1]?.slice(0, 3) ?? ''
      case 'B':
        return MONTHS[p.month - 1] ?? ''
      case 'a':
        return DAYS[p.weekday]?.slice(0, 3) ?? ''
      case 'A':
        return DAYS[p.weekday] ?? ''
      case 'j':
        return pad(dayOfYear(p), 3)
      case 'Z':
        return p.zoneName
      case 'z':
        return formatOffset(p.offsetMinutes)
      case 's':
        return String(Math.floor(date.getTime() / 1000))
      case 'F':
        return `${p.year}-${pad(p.month)}-${pad(p.day)}`
      case 'T':
        return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
      case '%':
        return '%'
      default:
        return whole
    }
  })
}

function dayOfYear(p: DateParts): number {
  const start = Date.UTC(p.year, 0, 1)
  const current = Date.UTC(p.year, p.month - 1, p.day)
  return Math.floor((current - start) / 86_400_000) + 1
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
}
