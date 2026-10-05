import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNavigation, type CompositeNavigationProp, type NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

export type TabParamList = {
  Home: undefined;
  Money: { flow?: 'all' | 'income' | 'expense'; bankId?: number | null; tab?: 'activity' | 'accounts' | 'people' } | undefined;
  Budget: undefined;
  Shared: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  TransactionDetail: { reference: string };
  Accounts: undefined;
  AccountDetail: { accountNumber: string; bank: number };
  AddAccount: { accountNumber?: string; bank?: number; accountHolderName?: string } | undefined;
  AddCash: { type?: 'DEBIT' | 'CREDIT'; withdrawalReference?: string } | undefined;
  Loans: { reference?: string } | undefined;
  Categories: undefined;
  AutoCategorization: undefined;
  Profiles: undefined;
  FailedParses: undefined;
  NotificationSettings: undefined;
  NotificationHistory: undefined;
  SharedGroup: { groupId: number };
  BudgetEdit: { budgetId?: number } | undefined;
  ScanAccount: undefined;
  People: undefined;
  PersonDetail: { personId: number };
  DriveBackup: undefined;
};

export type StackScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;

/** Navigation object usable from tab screens and shared components (can reach both tabs and stack routes). */
export type AppNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<TabParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export function useAppNavigation(): AppNavigation {
  return useNavigation<AppNavigation>();
}
