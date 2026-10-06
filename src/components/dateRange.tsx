import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSettings, useTheme } from '../store/settingsStore';
import { radius, spacing } from '../theme/colors';
import {
  dayOfMonth,
  formatRange,
  makeRange,
  matchingPreset,
  monthGrid,
  nextRangeSelection,
  presetRange,
  RANGE_PRESETS,
  WEEKDAY_INITIALS,
  type DateRange,
} from '../utils/dateRange';
import { formatDate } from '../utils/format';
import { addDays, nextPeriodStart, previousPeriodStart, sameDay, startOfDay } from '../utils/periodUtils';
import { Button, Chip, Icon, IconButton, Sheet, styles as ui } from './ui';

/** Pick a date range: a preset, or two taps on the calendar (one tap = a single day). */
export function DateRangeSheet(props: {
  visible: boolean;
  onClose: () => void;
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
}) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const [draft, setDraft] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [anchor, setAnchor] = useState(() => new Date());

  useEffect(() => {
    if (!props.visible) return;
    setDraft({ start: props.value?.start ?? null, end: props.value ? startOfDay(props.value.end) : null });
    setAnchor(props.value?.end ?? new Date());
  }, [props.visible, props.value]);

  const grid = useMemo(() => monthGrid(anchor, calendar), [anchor, calendar]);
  const today = startOfDay(new Date());
  const draftRange = draft.start ? makeRange(draft.start, draft.end ?? draft.start) : null;
  const preset = matchingPreset(draftRange, new Date(), calendar);

  const apply = (range: DateRange | null) => {
    props.onChange(range);
    props.onClose();
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Date range">
      <View style={{ gap: spacing.md }}>
        <View style={[ui.rowWrap, { gap: spacing.sm }]}>
          {RANGE_PRESETS.map((p) => (
            <Chip
              key={p.value}
              label={p.label}
              selected={preset === p.value}
              onPress={() => apply(presetRange(p.value, new Date(), calendar))}
            />
          ))}
        </View>

        <View style={styles.monthRow}>
          <IconButton name="chevron-left" accessibilityLabel="Previous month" onPress={() => setAnchor(addDays(grid.start, -1))} />
          <Text style={[styles.monthLabel, { color: colors.text }]}>{grid.label}</Text>
          <IconButton
            name="chevron-right"
            accessibilityLabel="Next month"
            color={grid.next.getTime() > today.getTime() ? colors.textMuted : colors.text}
            onPress={() => grid.next.getTime() <= today.getTime() && setAnchor(grid.next)}
          />
        </View>

        <View>
          <View style={styles.week}>
            {WEEKDAY_INITIALS.map((d, i) => (
              <Text key={i} style={[styles.weekday, { color: colors.textMuted }]}>
                {d}
              </Text>
            ))}
          </View>
          {grid.weeks.map((week, w) => (
            <View key={w} style={styles.week}>
              {week.map((day, i) => {
                if (!day) return <View key={i} style={styles.cell} />;
                const future = day.getTime() > today.getTime();
                const endpoint = (draft.start && sameDay(day, draft.start)) || (draft.end && sameDay(day, draft.end));
                const inside = !!draftRange && day.getTime() >= draftRange.start.getTime() && day.getTime() <= draftRange.end.getTime();
                return (
                  <Pressable
                    key={i}
                    disabled={future}
                    onPress={() => setDraft((current) => nextRangeSelection(current, day))}
                    style={[styles.cell, inside && !endpoint && { backgroundColor: colors.primarySoft }]}
                    accessibilityLabel={day.toDateString()}
                  >
                    <View style={[styles.day, endpoint && { backgroundColor: colors.primary }]}>
                      <Text
                        style={{
                          color: endpoint ? colors.onPrimary : future ? colors.textMuted : colors.text,
                          fontWeight: sameDay(day, today) || endpoint ? '700' : '400',
                        }}
                      >
                        {dayOfMonth(day, calendar)}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>
          {draftRange
            ? `${formatRange(draftRange, calendar)}${draft.end ? '' : ' · tap an end day'}`
            : 'Tap a start day, then an end day'}
        </Text>

        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button title="Clear" variant="ghost" style={{ flex: 1 }} onPress={() => apply(null)} />
          <Button title="Apply" style={{ flex: 1 }} disabled={!draftRange} onPress={() => apply(draftRange)} />
        </View>
      </View>
    </Sheet>
  );
}

/**
 * A date input that opens an inline month calendar on the chosen calendar (Ethiopian months have
 * 30 days, Pagume 5 or 6). Inline rather than a second sheet, so it works inside forms that are
 * already in a sheet.
 */
export function DateField(props: {
  label: string;
  value: Date | null;
  onChange: (date: Date | null) => void;
  placeholder?: string;
  /** Show a "None" button that clears the date. */
  clearable?: boolean;
}) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(() => props.value ?? new Date());
  const grid = useMemo(() => monthGrid(anchor, calendar), [anchor, calendar]);
  const today = startOfDay(new Date());

  const toggle = () => {
    if (!open) setAnchor(props.value ?? new Date());
    setOpen((o) => !o);
  };
  const pick = (day: Date | null) => {
    props.onChange(day);
    setOpen(false);
  };

  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>{props.label}</Text>
      <Pressable
        onPress={toggle}
        style={[styles.field, { backgroundColor: colors.surface, borderColor: open ? colors.primary : colors.border }]}
        accessibilityRole="button"
        accessibilityLabel={props.label}
      >
        <Text style={{ flex: 1, color: props.value ? colors.text : colors.textMuted }}>
          {props.value ? formatDate(props.value, calendar) : (props.placeholder ?? 'Pick a date')}
        </Text>
        <Icon name="event" size={20} color={colors.textSecondary} />
      </Pressable>
      {open ? (
        <View style={[styles.inlineCalendar, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <View style={styles.monthRow}>
            <IconButton
              name="chevron-left"
              accessibilityLabel="Previous month"
              onPress={() => setAnchor(previousPeriodStart(grid.start, 'monthly', calendar))}
            />
            <Text style={[styles.monthLabel, { color: colors.text }]}>{grid.label}</Text>
            <IconButton
              name="chevron-right"
              accessibilityLabel="Next month"
              onPress={() => setAnchor(nextPeriodStart(grid.start, 'monthly', calendar))}
            />
          </View>
          <View style={styles.week}>
            {WEEKDAY_INITIALS.map((d, i) => (
              <Text key={i} style={[styles.weekday, { color: colors.textMuted }]}>
                {d}
              </Text>
            ))}
          </View>
          {grid.weeks.map((week, w) => (
            <View key={w} style={styles.week}>
              {week.map((day, i) => {
                if (!day) return <View key={i} style={styles.cell} />;
                const selected = !!props.value && sameDay(day, props.value);
                return (
                  <Pressable key={i} onPress={() => pick(day)} style={styles.cell} accessibilityLabel={formatDate(day, calendar)}>
                    <View style={[styles.day, selected && { backgroundColor: colors.primary }]}>
                      <Text
                        style={{
                          color: selected ? colors.onPrimary : colors.text,
                          fontWeight: sameDay(day, today) || selected ? '700' : '400',
                        }}
                      >
                        {dayOfMonth(day, calendar)}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button title="Today" variant="ghost" compact style={{ flex: 1 }} onPress={() => pick(today)} />
            {props.clearable ? (
              <Button title="None" variant="ghost" compact style={{ flex: 1 }} onPress={() => pick(null)} />
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.input,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  inlineCalendar: { borderWidth: 1, borderRadius: 12, padding: spacing.sm, gap: 2 },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monthLabel: { fontSize: 16, fontWeight: '700' },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600', paddingVertical: spacing.xs },
  cell: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' },
  day: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
