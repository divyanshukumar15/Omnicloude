/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface DateValidationResult {
  isValid: boolean;
  isoDate: string | null; // Format: YYYY-MM-DD
  rawInput: string;
  errorCode?: 'IMPOSSIBLE_CALENDAR_DATE' | 'INVALID_DATE_FORMAT' | 'YEAR_OUT_OF_RANGE' | 'NON_LEAP_YEAR_FEB_29';
  errorMessage?: string;
}

const HINDI_MONTH_MAP: Record<string, number> = {
  जनवरी: 1,
  फरवरी: 2,
  फ़रवरी: 2,
  मार्च: 3,
  अप्रैल: 4,
  मई: 5,
  जून: 6,
  जुलाई: 7,
  अगस्त: 8,
  सितंबर: 9,
  सितम्बर: 9,
  अक्टूबर: 10,
  नवंबर: 11,
  नवम्बर: 11,
  दिसंबर: 12,
  दिसम्बर: 12,
};

const ENGLISH_MONTH_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export class DateValidator {
  /**
   * Checks if a raw date string represents a valid real-world calendar date.
   */
  public static isValidCalendarDate(raw: string): boolean {
    return DateValidator.parseAndValidate(raw).isValid;
  }

  /**
   * Determines if a given year is a valid Gregorian leap year.
   */
  public static isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  /**
   * Returns the exact maximum number of days in a given month and year.
   */
  public static getDaysInMonth(year: number, month: number): number {
    switch (month) {
      case 1: // January
      case 3: // March
      case 5: // May
      case 7: // July
      case 8: // August
      case 10: // October
      case 12: // December
        return 31;
      case 4: // April
      case 6: // June
      case 9: // September
      case 11: // November
        return 30;
      case 2: // February
        return DateValidator.isLeapYear(year) ? 29 : 28;
      default:
        return 0;
    }
  }

  /**
   * Strictly validates calendar dates rejecting impossible dates like 31/02/2026 or 31/04/2026.
   * Does NOT rely on naive JavaScript Date.parse() which silently rolls over invalid dates!
   */
  public static validateCalendarDate(day: number, month: number, year: number, rawInput: string): DateValidationResult {
    if (year < 1950 || year > 2099) {
      return {
        isValid: false,
        isoDate: null,
        rawInput,
        errorCode: 'YEAR_OUT_OF_RANGE',
        errorMessage: `Year ${year} is outside valid range (1950-2099)`,
      };
    }

    if (month < 1 || month > 12) {
      return {
        isValid: false,
        isoDate: null,
        rawInput,
        errorCode: 'IMPOSSIBLE_CALENDAR_DATE',
        errorMessage: `Invalid month ${month} (must be 1-12)`,
      };
    }

    const maxDays = DateValidator.getDaysInMonth(year, month);

    if (day === 29 && month === 2 && !DateValidator.isLeapYear(year)) {
      return {
        isValid: false,
        isoDate: null,
        rawInput,
        errorCode: 'NON_LEAP_YEAR_FEB_29',
        errorMessage: `February 29 is invalid in non-leap year ${year}`,
      };
    }

    if (day < 1 || day > maxDays) {
      return {
        isValid: false,
        isoDate: null,
        rawInput,
        errorCode: 'IMPOSSIBLE_CALENDAR_DATE',
        errorMessage: `Impossible date: Month ${month} in year ${year} has max ${maxDays} days, got day ${day}`,
      };
    }

    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const isoDate = `${year}-${mm}-${dd}`;

    return {
      isValid: true,
      isoDate,
      rawInput,
    };
  }

  /**
   * Parses and validates raw date string across common official Indian notification formats.
   */
  public static parseAndValidate(raw: string): DateValidationResult {
    if (!raw || typeof raw !== 'string') {
      return {
        isValid: false,
        isoDate: null,
        rawInput: String(raw),
        errorCode: 'INVALID_DATE_FORMAT',
        errorMessage: 'Empty or non-string date input',
      };
    }

    const trimmed = raw.trim();

    // 1. Numeric formats: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
    const dmyMatch = trimmed.match(/^([0-3]?[0-9])[\/\-\.]([0-1]?[0-9])[\/\-\.](\d{4})$/);
    if (dmyMatch) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10);
      const year = parseInt(dmyMatch[3], 10);
      return DateValidator.validateCalendarDate(day, month, year, raw);
    }

    // 2. ISO format: YYYY-MM-DD
    const isoMatch = trimmed.match(/^(\d{4})[\/\-\.]([0-1]?[0-9])[\/\-\.]([0-3]?[0-9])$/);
    if (isoMatch) {
      const year = parseInt(isoMatch[1], 10);
      const month = parseInt(isoMatch[2], 10);
      const day = parseInt(isoMatch[3], 10);
      return DateValidator.validateCalendarDate(day, month, year, raw);
    }

    // 3. Textual English format: "15th March 2026", "21 February 2026", "March 15, 2026"
    const cleanedEnglish = trimmed.replace(/(\d+)(st|nd|rd|th)/i, '$1');
    const engMatch = cleanedEnglish.match(/([0-3]?[0-9])\s+([A-Za-z]+)\s+(\d{4})/);
    if (engMatch) {
      const day = parseInt(engMatch[1], 10);
      const monthName = engMatch[2].toLowerCase();
      const year = parseInt(engMatch[3], 10);
      const month = ENGLISH_MONTH_MAP[monthName];
      if (month) {
        return DateValidator.validateCalendarDate(day, month, year, raw);
      }
    }

    const engMonthFirst = cleanedEnglish.match(/([A-Za-z]+)\s+([0-3]?[0-9]),?\s+(\d{4})/);
    if (engMonthFirst) {
      const monthName = engMonthFirst[1].toLowerCase();
      const day = parseInt(engMonthFirst[2], 10);
      const year = parseInt(engMonthFirst[3], 10);
      const month = ENGLISH_MONTH_MAP[monthName];
      if (month) {
        return DateValidator.validateCalendarDate(day, month, year, raw);
      }
    }

    // 4. Textual Hindi format: "15 मार्च 2026", "21 फरवरी 2026"
    const hindiMatch = trimmed.match(/([0-3]?[0-9])\s+([^\s\d]+)\s+(\d{4})/);
    if (hindiMatch) {
      const day = parseInt(hindiMatch[1], 10);
      const hindiMonthName = hindiMatch[2].trim();
      const year = parseInt(hindiMatch[3], 10);
      const month = HINDI_MONTH_MAP[hindiMonthName];
      if (month) {
        return DateValidator.validateCalendarDate(day, month, year, raw);
      }
    }

    // 5. Month-Year format: "June 2026", "जून 2026" (Commonly used for exam schedules)
    const engMonthYear = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (engMonthYear) {
      const monthName = engMonthYear[1].toLowerCase();
      const year = parseInt(engMonthYear[2], 10);
      const month = ENGLISH_MONTH_MAP[monthName];
      if (month && year >= 1950 && year <= 2099) {
        const mm = String(month).padStart(2, '0');
        return {
          isValid: true,
          isoDate: `${year}-${mm}`,
          rawInput: raw,
        };
      }
    }

    const hindiMonthYear = trimmed.match(/^([^\s\d]+)\s+(\d{4})$/);
    if (hindiMonthYear) {
      const hindiMonthName = hindiMonthYear[1].trim();
      const year = parseInt(hindiMonthYear[2], 10);
      const month = HINDI_MONTH_MAP[hindiMonthName];
      if (month && year >= 1950 && year <= 2099) {
        const mm = String(month).padStart(2, '0');
        return {
          isValid: true,
          isoDate: `${year}-${mm}`,
          rawInput: raw,
        };
      }
    }

    return {
      isValid: false,
      isoDate: null,
      rawInput: raw,
      errorCode: 'INVALID_DATE_FORMAT',
      errorMessage: `Could not parse date format: "${raw}"`,
    };
  }

  /**
   * Verifies chronological order between application start date and application last date.
   */
  public static validateDateSequence(
    startDateIso: string | null,
    endDateIso: string | null
  ): { isValid: boolean; isConflict: boolean; message?: string } {
    if (!startDateIso || !endDateIso) {
      return { isValid: true, isConflict: false };
    }

    const start = new Date(startDateIso).getTime();
    const end = new Date(endDateIso).getTime();

    if (isNaN(start) || isNaN(end)) {
      return { isValid: false, isConflict: false, message: 'Invalid ISO date string provided for sequence check' };
    }

    if (start > end) {
      return {
        isValid: false,
        isConflict: true,
        message: `Application start date (${startDateIso}) cannot be after last date (${endDateIso})`,
      };
    }

    return { isValid: true, isConflict: false };
  }
}
