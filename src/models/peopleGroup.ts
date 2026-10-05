/** A saved set of people (flatmates, a team…) used to fill a bill split in one tap. */
export interface PeopleGroup {
  id: number;
  name: string;
  memberIds: number[];
  profileId?: number | null;
  createdAt: string;
  updatedAt?: string | null;
}

export function peopleGroupFromDb(row: Record<string, any>, memberIds: number[]): PeopleGroup {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    memberIds,
    profileId: row.profileId ?? null,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? null,
  };
}
