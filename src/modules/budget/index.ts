/**
 * Budget module — per-user spend tracking and monthly caps.
 *
 * Registers the `record_usage` delivery action, which the container writes
 * at the end of every turn. The pre-wake cap check is called directly from
 * src/router.ts (deliverToAgent). Schema: migration 016.
 *
 * Operator commands:
 *   ncl user-monthly-spends list                       — spend per user per month
 *   ncl user-budgets create --user_id discord:<id> --monthly_cap_usd 50
 *   ncl user-budgets update --id discord:<id> --monthly_cap_usd 50
 *   (monthly_cap_usd empty/NULL = uncapped; owners are always uncapped)
 */
import { registerDeliveryAction } from '../../delivery.js';
import { recordUsage } from './budget.js';

registerDeliveryAction('record_usage', recordUsage);
