import type { MondayClient } from '../monday/client';
import type { PortalView } from '../types';

export async function loadPortalData(donorItemIds: string[], monday: MondayClient): Promise<PortalView> {
  const [donors, discounts] = await Promise.all([
    Promise.all(donorItemIds.map((id) => monday.getDonorPortalData(id))),
    monday.getDiscountOrganizations(),
  ]);

  return { donors, discounts };
}
