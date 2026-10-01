import { MaterialIcons } from '@expo/vector-icons';
import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../store/settingsStore';
import { radius, spacing } from '../theme/colors';

export type IconName = keyof typeof MaterialIcons.glyphMap;

export function Icon(props: { name: string; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  const colors = useTheme();
  return (
    <MaterialIcons
      name={props.name as IconName}
      size={props.size ?? 22}
      color={props.color ?? colors.text}
      style={props.style}
    />
  );
}

/** Root container for tab screens (stack screens get their header from the navigator). */
export function Screen(props: {
  children: ReactNode;
  scroll?: boolean;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: React.ReactElement<any>;
}) {
  const colors = useTheme();
  const edges = props.edges ?? ['left', 'right'];
  if (props.scroll === false) {
    return (
      <SafeAreaView edges={edges} style={[styles.flex, { backgroundColor: colors.background }]}>
        <View style={[styles.flex, props.contentStyle]}>{props.children}</View>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView edges={edges} style={[styles.flex, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.screenContent, props.contentStyle]}
        keyboardShouldPersistTaps="handled"
        refreshControl={props.refreshControl}
      >
        {props.children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Card(props: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const colors = useTheme();
  const style = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, props.style];
  if (props.onPress) {
    return (
      <Pressable onPress={props.onPress} style={({ pressed }) => [style, pressed && { opacity: 0.85 }]}>
        {props.children}
      </Pressable>
    );
  }
  return <View style={style}>{props.children}</View>;
}

export function SectionTitle(props: { title: string; action?: { label: string; onPress: () => void } }) {
  const colors = useTheme();
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{props.title.toUpperCase()}</Text>
      {props.action ? (
        <Pressable onPress={props.action.onPress} hitSlop={8}>
          <Text style={{ color: colors.primary, fontWeight: '600' }}>{props.action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button(props: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: string;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const colors = useTheme();
  const variant = props.variant ?? 'primary';
  const bg =
    variant === 'primary'
      ? colors.primary
      : variant === 'danger'
        ? colors.expense
        : variant === 'secondary'
          ? colors.surfaceMuted
          : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? colors.onPrimary : variant === 'ghost' ? colors.primary : colors.text;
  const disabled = props.disabled || props.loading;
  return (
    <Pressable
      onPress={props.onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        props.compact && styles.buttonCompact,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        props.style,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <>
          {props.icon ? <Icon name={props.icon} size={18} color={fg} /> : null}
          <Text style={[styles.buttonText, { color: fg }]}>{props.title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function IconButton(props: { name: string; onPress: () => void; color?: string; size?: number; accessibilityLabel?: string }) {
  const colors = useTheme();
  return (
    <Pressable
      onPress={props.onPress}
      hitSlop={8}
      accessibilityLabel={props.accessibilityLabel}
      style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: colors.surfaceMuted }]}
    >
      <Icon name={props.name} size={props.size ?? 22} color={props.color ?? colors.text} />
    </Pressable>
  );
}

export function TextField(props: TextInputProps & { label?: string; error?: string | null; containerStyle?: StyleProp<ViewStyle> }) {
  const colors = useTheme();
  const { label, error, containerStyle, style, ...rest } = props;
  return (
    <View style={[styles.fieldContainer, containerStyle]}>
      {label ? <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textMuted}
        {...rest}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.surface,
            borderColor: error ? colors.expense : colors.border,
          },
          rest.multiline && { minHeight: 80, textAlignVertical: 'top' },
          style,
        ]}
      />
      {error ? <Text style={[styles.fieldError, { color: colors.expense }]}>{error}</Text> : null}
    </View>
  );
}

export function ListRow(props: {
  title: string;
  subtitle?: string | null;
  icon?: string;
  iconColor?: string;
  left?: ReactNode;
  right?: ReactNode;
  value?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const colors = useTheme();
  const titleColor = props.destructive ? colors.expense : colors.text;
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      disabled={props.disabled || (!props.onPress && !props.onLongPress)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceMuted }, props.disabled && { opacity: 0.5 }]}
    >
      {props.left ??
        (props.icon ? (
          <View style={[styles.rowIcon, { backgroundColor: colors.primarySoft }]}>
            <Icon name={props.icon} size={20} color={props.iconColor ?? (props.destructive ? colors.expense : colors.primary)} />
          </View>
        ) : null)}
      <View style={styles.flex}>
        <Text style={[styles.rowTitle, { color: titleColor }]} numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]} numberOfLines={2}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.value ? <Text style={{ color: colors.textSecondary, marginLeft: spacing.sm }}>{props.value}</Text> : null}
      {props.right}
      {props.chevron ? <Icon name="chevron-right" color={colors.textMuted} /> : null}
    </Pressable>
  );
}

export function ToggleRow(props: {
  title: string;
  subtitle?: string | null;
  icon?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const colors = useTheme();
  return (
    <ListRow
      title={props.title}
      subtitle={props.subtitle}
      icon={props.icon}
      disabled={props.disabled}
      onPress={() => props.onValueChange(!props.value)}
      right={
        <Switch
          value={props.value}
          disabled={props.disabled}
          onValueChange={props.onValueChange}
          trackColor={{ true: colors.primary, false: colors.border }}
          thumbColor={colors.surface}
        />
      }
    />
  );
}

export function Divider() {
  const colors = useTheme();
  return <View style={[styles.divider, { backgroundColor: colors.border }]} />;
}

export function SegmentedControl<T extends string>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: colors.surfaceMuted }, props.style]}>
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            onPress={() => props.onChange(option.value)}
            style={[styles.segment, selected && { backgroundColor: colors.surface }]}
          >
            <Text
              style={{ color: selected ? colors.text : colors.textSecondary, fontWeight: selected ? '700' : '500' }}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip(props: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  color?: string;
  icon?: string;
}) {
  const colors = useTheme();
  const accent = props.color ?? colors.primary;
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      style={[
        styles.chip,
        {
          borderColor: props.selected ? accent : colors.border,
          backgroundColor: props.selected ? `${accent}22` : colors.surface,
        },
      ]}
    >
      {props.icon ? <Icon name={props.icon} size={16} color={props.selected ? accent : colors.textSecondary} /> : null}
      <Text style={{ color: props.selected ? accent : colors.text, fontWeight: props.selected ? '600' : '400' }}>{props.label}</Text>
    </Pressable>
  );
}

export function EmptyState(props: { icon?: string; title: string; message?: string; action?: { label: string; onPress: () => void } }) {
  const colors = useTheme();
  return (
    <View style={styles.empty}>
      <Icon name={props.icon ?? 'inbox'} size={44} color={colors.textMuted} />
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{props.title}</Text>
      {props.message ? <Text style={[styles.emptyMessage, { color: colors.textSecondary }]}>{props.message}</Text> : null}
      {props.action ? <Button title={props.action.label} onPress={props.action.onPress} style={{ marginTop: spacing.md }} /> : null}
    </View>
  );
}

export function Loading() {
  const colors = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: colors.background }]}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export function ProgressBar(props: { progress: number; color?: string; height?: number }) {
  const colors = useTheme();
  const pct = Math.max(0, Math.min(1, Number.isFinite(props.progress) ? props.progress : 0));
  return (
    <View style={[styles.progressTrack, { backgroundColor: colors.surfaceMuted, height: props.height ?? 8 }]}>
      <View style={{ width: `${pct * 100}%`, backgroundColor: props.color ?? colors.primary, height: '100%', borderRadius: radius.pill }} />
    </View>
  );
}

/** Bottom sheet style modal. */
export function Sheet(props: { visible: boolean; onClose: () => void; title?: string; children: ReactNode; scroll?: boolean }) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <Pressable style={styles.backdrop} onPress={props.onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.background, paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
          {props.title ? (
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>{props.title}</Text>
              <IconButton name="close" onPress={props.onClose} />
            </View>
          ) : null}
          {props.scroll === false ? (
            props.children
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: spacing.md }}>
              {props.children}
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Pill(props: { label: string; color?: string }) {
  const colors = useTheme();
  const c = props.color ?? colors.primary;
  return (
    <View style={[styles.pill, { backgroundColor: `${c}22` }]}>
      <Text style={{ color: c, fontSize: 12, fontWeight: '600' }}>{props.label}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  screenContent: { padding: spacing.lg, paddingBottom: spacing.xl * 2, gap: spacing.md },
  card: { borderRadius: radius.card * 2, borderWidth: StyleSheet.hairlineWidth, padding: spacing.lg, overflow: 'hidden' },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.input,
    minHeight: 46,
  },
  buttonCompact: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, minHeight: 36 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  iconButton: { padding: 6, borderRadius: radius.pill },
  fieldContainer: { gap: spacing.xs },
  fieldLabel: { fontSize: 13, fontWeight: '600' },
  fieldError: { fontSize: 12 },
  input: {
    borderWidth: 1,
    borderRadius: radius.input,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.md : spacing.sm,
    fontSize: 15,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, paddingHorizontal: spacing.xs },
  rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 15, fontWeight: '500' },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.xs },
  segmented: { flexDirection: 'row', borderRadius: radius.input, padding: 3 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.input - 3 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  empty: { alignItems: 'center', padding: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptyMessage: { fontSize: 14, textAlign: 'center' },
  progressTrack: { borderRadius: radius.pill, overflow: 'hidden', width: '100%' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    maxHeight: '88%',
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginVertical: spacing.sm },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  sheetTitle: { fontSize: 18, fontWeight: '700' },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, alignSelf: 'flex-start' },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
