import { registerResource } from '../crud.js';

registerResource({
  name: 'user-budget',
  plural: 'user-budgets',
  table: 'user_budgets',
  description:
    'Per-user monthly spend cap override. Users without a row get the default cap ($20); owners are always uncapped.',
  idColumn: 'user_id',
  columns: [
    { name: 'user_id', type: 'string', description: 'Namespaced user id, e.g. "discord:123456789".', required: true },
    {
      name: 'monthly_cap_usd',
      type: 'number',
      description: 'Monthly cap in USD. Leave empty (NULL) for uncapped.',
      updatable: true,
    },
    { name: 'note', type: 'string', description: 'Why this override exists.', updatable: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
});

registerResource({
  name: 'user-monthly-spend',
  plural: 'user-monthly-spends',
  table: 'user_monthly_spend',
  description: 'Read-only: agent spend per user per UTC calendar month (id = "<user_id>@YYYY-MM").',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: '"<user_id>@YYYY-MM".', generated: true },
    { name: 'user_id', type: 'string', description: 'Namespaced user id.', generated: true },
    { name: 'month', type: 'string', description: 'YYYY-MM (UTC).', generated: true },
    { name: 'display_name', type: 'string', description: 'From users.display_name.', generated: true },
    { name: 'cost_usd', type: 'number', description: 'Spend in USD at list prices.', generated: true },
    { name: 'turns', type: 'number', description: 'Agent turns attributed (fully or shared).', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
});
