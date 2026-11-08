export type Status = 'ACTIVE' | 'INACTIVE';
export type DivisionView = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: Status;
  version: number;
};
export type PositionView = {
  id: string;
  code: string;
  name: string;
  division: { id: string; code: string; name: string };
  status: Status;
  version: number;
};
export interface Page<T> {
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}
