export function mapUserRow(row) {
  return row ? { id: row.id, mobile: row.mobile, role: row.role,
    displayName: row.display_name, isActive: row.is_active,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}
