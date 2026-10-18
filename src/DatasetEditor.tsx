import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DataGrid, { textEditor, type Column, type SortColumn } from 'react-data-grid';
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, Columns3, Download, FilePlus2,
  History as HistoryIcon, LoaderCircle, Plus, Redo2, RotateCcw, Save, Search,
  Trash2, Undo2, WandSparkles, X,
} from 'lucide-react';
import {
  api,
  type Dataset,
  type EditorColumn,
  type EditorOperation,
  type EditorTransformPreview,
  type EditorTransformationHistory,
} from './api';
import 'react-data-grid/lib/styles.css';

type EditorRow = Record<string, unknown>;
type TransformAudit = {
  operation: string;
  columns: string[];
  affected_cells: number;
  affected_rows: number;
  created_at: string;
};
type EditorType = 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN' | 'DATE';
type HistoryEntry = {
  forward: EditorOperation[];
  undo: EditorOperation[];
  label: string;
  audit?: TransformAudit;
};
type TransformTab = 'replace' | 'missing' | 'bulk' | 'columns' | 'cleaning' | 'advanced' | 'history';
type TransformConfig = Record<string, unknown>;
type EditorProps = {
  dataset: Dataset;
  onClose: () => void;
  onSaved: (dataset: Dataset) => void;
  onToast: (message: string) => void;
};

const PAGE_SIZE = 100;
const MAX_HISTORY = 100;

function normalizeColumnName(value: string, index: number): string {
  let name = value.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || `column_${index + 1}`;
  if (/^[0-9]/.test(name)) name = `column_${name}`;
  return name;
}

function applyOperations(
  originalRows: EditorRow[],
  originalColumns: EditorColumn[],
  rowKey: string,
  operations: EditorOperation[],
  pageOffset: number,
): { rows: EditorRow[]; columns: EditorColumn[] } {
  let rows = originalRows.map((row) => ({ ...row }));
  let columns = [...originalColumns];
  for (const operation of operations) {
    if (operation.type === 'set_cells') {
      const changes = new Map<string, Record<string, unknown>>();
      for (const cell of operation.cells) {
        const id = String(cell.row_id);
        changes.set(id, { ...changes.get(id), [cell.column]: cell.value });
      }
      rows = rows.map((row) => changes.has(String(row[rowKey]))
        ? { ...row, ...changes.get(String(row[rowKey])) }
        : row);
    } else if (operation.type === 'insert_rows') {
      const visibleIds = new Set(originalRows.map((row) => String(row[rowKey])));
      const restored = operation.rows.filter((item) => pageOffset === 0 || visibleIds.has(String(item.id)));
      rows = [
        ...restored.filter((item) => !rows.some((row) => String(row[rowKey]) === String(item.id)))
          .map((item) => ({ ...item.values, [rowKey]: item.id ?? `new:${crypto.randomUUID()}` })),
        ...rows,
      ];
    } else if (operation.type === 'delete_rows') {
      const remove = new Set(operation.row_ids.map(String));
      rows = rows.filter((row) => !remove.has(String(row[rowKey])));
    } else if (operation.type === 'add_column') {
      const name = normalizeColumnName(operation.name, columns.length);
      columns = [...columns, { name, type: operation.column_type }];
      rows = rows.map((row) => ({ ...row, [name]: null }));
    } else if (operation.type === 'delete_column') {
      columns = columns.filter((column) => column.name !== operation.name);
      rows = rows.map((row) => {
        const next = { ...row };
        delete next[operation.name];
        return next;
      });
    } else if (operation.type === 'convert_column') {
      columns = columns.map((column) => column.name === operation.name
        ? { ...column, type: operation.column_type }
        : column);
    } else if (operation.type === 'rename_column') {
      const name = normalizeColumnName(operation.name, 0);
      columns = columns.map((column) => column.name === operation.old_name ? { ...column, name } : column);
      rows = rows.map((row) => {
        const next = { ...row };
        next[name] = next[operation.old_name];
        delete next[operation.old_name];
        return next;
      });
    }
  }
  return { rows, columns };
}

function validateCell(value: unknown, column: EditorColumn): string | null {
  if (value === null || value === '') return null;
  if (column.type === 'INTEGER' && !/^[+-]?\d+$/.test(String(value).trim())) {
    return `Enter a whole number for ${column.name}.`;
  }
  if (column.type === 'REAL' && !Number.isFinite(Number(value))) {
    return `Enter a valid number for ${column.name}.`;
  }
  if (column.type === 'BOOLEAN' && !/^(true|false|yes|no|y|n|0|1)$/i.test(String(value).trim())) {
    return `Enter true/false, yes/no, or 1/0 for ${column.name}.`;
  }
  if (column.type === 'DATE' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) {
    return `Enter an ISO date (YYYY-MM-DD) for ${column.name}.`;
  }
  return null;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function DatasetEditor({ dataset, onClose, onSaved, onToast }: EditorProps) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [filterColumn, setFilterColumn] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [sortColumns, setSortColumns] = useState<SortColumn[]>([]);
  const [baseRows, setBaseRows] = useState<EditorRow[]>([]);
  const [baseColumns, setBaseColumns] = useState<EditorColumn[]>([]);
  const [rowKey, setRowKey] = useState('');
  const [baseTotal, setBaseTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveAsName, setSaveAsName] = useState('');
  const [newColumnName, setNewColumnName] = useState('');
  const [newColumnType, setNewColumnType] = useState<EditorType>('TEXT');
  const [transformOpen, setTransformOpen] = useState(false);
  const [transformTab, setTransformTab] = useState<TransformTab>('replace');
  const [transformColumn, setTransformColumn] = useState('');
  const [findValue, setFindValue] = useState('');
  const [replacementValue, setReplacementValue] = useState('');
  const [matchMode, setMatchMode] = useState<'exact' | 'contains'>('exact');
  const [matchCase, setMatchCase] = useState(true);
  const [replaceAll, setReplaceAll] = useState(true);
  const [fillMode, setFillMode] = useState<'value' | 'mean' | 'median' | 'mode'>('value');
  const [missingAction, setMissingAction] = useState<'fill' | 'remove_rows' | 'standardize_markers'>('fill');
  const [missingMarkers, setMissingMarkers] = useState('N/A, NA, null, None');
  const [conditionColumn, setConditionColumn] = useState('');
  const [conditionOperator, setConditionOperator] = useState('equals');
  const [conditionValue, setConditionValue] = useState('');
  const [columnAction, setColumnAction] = useState<
    'trim' | 'uppercase' | 'lowercase' | 'round' | 'convert_type' | 'rename' | 'split' | 'combine' | 'calculate'
  >('trim');
  const [targetType, setTargetType] = useState<EditorType>('TEXT');
  const [roundDigits, setRoundDigits] = useState('0');
  const [transformOutputName, setTransformOutputName] = useState('');
  const [transformSecondName, setTransformSecondName] = useState('');
  const [transformDelimiter, setTransformDelimiter] = useState(',');
  const [calculationExpression, setCalculationExpression] = useState('');
  const [combineColumns, setCombineColumns] = useState<string[]>([]);
  const [cleaningPreset, setCleaningPreset] = useState('trim_text');
  const [rangeMinimum, setRangeMinimum] = useState('');
  const [rangeMaximum, setRangeMaximum] = useState('');
  const [rangeFlagName, setRangeFlagName] = useState('review_flag');
  const [transformBusy, setTransformBusy] = useState(false);
  const [transformPreview, setTransformPreview] = useState<EditorTransformPreview | null>(null);
  const [transformPreviewLabel, setTransformPreviewLabel] = useState('');
  const [previewSignature, setPreviewSignature] = useState('');
  const [savedTransformHistory, setSavedTransformHistory] = useState<EditorTransformationHistory[]>([]);
  const [advancedOperation, setAdvancedOperation] = useState<
    'remove_missing_rows' | 'remove_duplicates' | 'remove_missing_columns'
  >('remove_missing_rows');
  const historyRef = useRef(history);
  const cursorRef = useRef(cursor);
  const dirty = cursor > 0;
  historyRef.current = history;
  cursorRef.current = cursor;
  const activeOperations = useMemo(
    () => history.slice(0, cursor).flatMap((entry) => entry.forward),
    [history, cursor],
  );
  const edited = useMemo(
    () => applyOperations(baseRows, baseColumns, rowKey, activeOperations, offset),
    [baseRows, baseColumns, rowKey, activeOperations, offset],
  );

  const reload = useCallback(async () => {
    if (!dataset.id) return;
    setBusy(true);
    setError('');
    try {
      const sort = sortColumns[0];
      const result = await api.editorRecords(
        dataset.id,
        offset,
        PAGE_SIZE,
        search,
        sort?.columnKey ?? '',
        sort?.direction === 'DESC' ? 'desc' : 'asc',
        filterColumn,
        filterValue,
      );
      setBaseRows(result.rows);
      setBaseColumns(result.columns);
      setRowKey(result.row_key);
      setBaseTotal(result.total);
      setSelected(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load editable records.');
    } finally {
      setBusy(false);
    }
  }, [dataset.id, offset, search, sortColumns, filterColumn, filterValue]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    void api.editorTransformationHistory(dataset.id)
      .then(setSavedTransformHistory)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not load transformation history.'));
  }, [dataset.id]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const requestClose = () => {
    if (dirty && !window.confirm('Discard unsaved dataset changes and close the editor?')) return;
    onClose();
  };

  const push = (
    forward: EditorOperation | EditorOperation[],
    undo: EditorOperation | EditorOperation[],
    label: string,
    audit?: TransformAudit,
  ) => {
    if (history.length >= MAX_HISTORY && cursor === history.length) {
      setError(`Editing history is limited to ${MAX_HISTORY} actions. Save Changes to clear the history before continuing.`);
      return;
    }
    const next = [...history.slice(0, cursor), {
      forward: Array.isArray(forward) ? forward : [forward],
      undo: Array.isArray(undo) ? undo : [undo],
      label,
      audit,
    }];
    setHistory(next);
    setCursor(next.length);
    setError('');
  };

  const undo = useCallback(() => {
    if (cursorRef.current <= 0) return;
    setCursor((value) => Math.max(0, value - 1));
    setSelected(new Set());
  }, []);

  const redo = useCallback(() => {
    if (cursorRef.current >= historyRef.current.length) return;
    setCursor((value) => Math.min(historyRef.current.length, value + 1));
    setSelected(new Set());
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (key === 'y') {
        event.preventDefault();
        redo();
      } else if (key === 'z') {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [undo, redo]);

  const gridColumns = useMemo<Column<EditorRow>[]>(() => [
    {
      key: '__select__',
      name: '',
      width: 46,
      resizable: false,
      sortable: false,
      renderHeaderCell: () => <input
        type="checkbox"
        aria-label="Select all rows on page"
        checked={edited.rows.length > 0 && edited.rows.every((row) => selected.has(String(row[rowKey])))}
        onChange={(event) => setSelected(event.target.checked ? new Set(edited.rows.map((row) => String(row[rowKey]))) : new Set())}
      />,
      renderCell: ({ row }) => <input
        type="checkbox"
        aria-label={`Select row ${String(row[rowKey])}`}
        checked={selected.has(String(row[rowKey]))}
        onChange={(event) => setSelected((current) => {
          const next = new Set(current);
          if (event.target.checked) next.add(String(row[rowKey]));
          else next.delete(String(row[rowKey]));
          return next;
        })}
      />,
    },
    ...edited.columns.map((column) => ({
      key: column.name,
      name: column.name,
      resizable: true,
      sortable: true,
      editable: true,
      renderEditCell: textEditor,
      renderCell: ({ row }: { row: EditorRow }) => row[column.name] === null || row[column.name] === undefined
        ? <span className="text-slate-600 italic">NULL</span>
        : String(row[column.name]),
    })),
  ], [edited.columns, edited.rows, rowKey, selected]);

  const onRowsChange = (nextRows: EditorRow[]) => {
    const oldRows = new Map(edited.rows.map((row) => [String(row[rowKey]), row]));
    const cells: Array<{ row_id: number | string; column: string; value: unknown }> = [];
    for (const nextRow of nextRows) {
      const id = String(nextRow[rowKey]);
      const previous = oldRows.get(id);
      if (!previous) continue;
      for (const column of edited.columns) {
        if (String(previous[column.name] ?? '') === String(nextRow[column.name] ?? '')) continue;
        const problem = validateCell(nextRow[column.name], column);
        if (problem) {
          setError(problem);
          return;
        }
        cells.push({ row_id: id, column: column.name, value: nextRow[column.name] });
      }
    }
    if (!cells.length) return;
    const previousValues = cells.map((cell) => ({
      ...cell,
      value: oldRows.get(String(cell.row_id))?.[cell.column] ?? null,
    }));
    push({ type: 'set_cells', cells }, { type: 'set_cells', cells: previousValues }, 'Edit cells');
  };

  const addRow = () => {
    if (!edited.columns.length) return;
    const id = `new:${crypto.randomUUID()}`;
    const values = Object.fromEntries(edited.columns.map((column) => [column.name, null]));
    push({ type: 'insert_rows', rows: [{ id, values }] }, { type: 'delete_rows', row_ids: [id] }, 'Add row');
  };

  const deleteRows = () => {
    if (!selected.size) return;
    const selectedRows = edited.rows.filter((row) => selected.has(String(row[rowKey])));
    if (!window.confirm(`Delete ${selectedRows.length} selected row${selectedRows.length === 1 ? '' : 's'} from the working copy? You can undo before saving.`)) return;
    const removed = selectedRows.map((row) => ({
      id: row[rowKey] as number | string,
      values: Object.fromEntries(edited.columns.map((column) => [column.name, row[column.name] ?? null])),
    }));
    push(
      { type: 'delete_rows', row_ids: removed.map((row) => row.id) },
      { type: 'insert_rows', rows: removed },
      `Delete ${removed.length} row${removed.length === 1 ? '' : 's'}`,
    );
    setSelected(new Set());
  };

  const addColumn = () => {
    const name = normalizeColumnName(newColumnName, edited.columns.length);
    if (!newColumnName.trim()) {
      setError('Enter a column name.');
      return;
    }
    if (edited.columns.some((column) => column.name === name)) {
      setError(`Column “${name}” already exists.`);
      return;
    }
    push(
      { type: 'add_column', name, column_type: newColumnType },
      { type: 'delete_column', name },
      `Add column ${name}`,
    );
    setNewColumnName('');
  };

  const renameColumn = () => {
    if (!edited.columns.length) return;
    const selectedColumn = window.prompt('Enter the column name to rename:', edited.columns[0].name);
    if (selectedColumn === null) return;
    const oldName = edited.columns.find((column) => column.name === selectedColumn)?.name;
    if (!oldName) {
      setError('Choose an existing column name exactly as shown.');
      return;
    }
    const rawName = window.prompt('Enter the new column name:', oldName);
    if (rawName === null) return;
    const name = normalizeColumnName(rawName, 0);
    if (!rawName.trim() || edited.columns.some((column) => column.name === name && column.name !== oldName)) {
      setError('Enter a non-empty, unique column name.');
      return;
    }
    push(
      { type: 'rename_column', old_name: oldName, name },
      { type: 'rename_column', old_name: name, name: oldName },
      `Rename ${oldName}`,
    );
  };

  const deleteColumn = () => {
    if (edited.columns.length <= 1) {
      setError('A dataset must keep at least one column.');
      return;
    }
    const name = window.prompt(`Enter the column name to delete:\n${edited.columns.map((column) => column.name).join(', ')}`);
    if (name === null) return;
    if (!edited.columns.some((column) => column.name === name)) {
      setError('Choose an existing column name exactly as shown.');
      return;
    }
    if (!window.confirm(`Delete column “${name}” and its values from the working copy?`)) return;
    push({ type: 'delete_column', name }, { type: 'add_column', name, column_type: 'TEXT' }, `Delete column ${name}`);
  };

  const markerList = () => missingMarkers.split(',').map((marker) => marker.trim()).filter(Boolean);
  const selectedTransformColumn = transformColumn || edited.columns[0]?.name || '';
  const selectedConditionColumn = conditionColumn || edited.columns[0]?.name || '';
  const numericColumns = edited.columns.filter((column) => ['INTEGER', 'REAL'].includes(column.type.toUpperCase()));
  const selectedNumericColumn = numericColumns.some((column) => column.name === selectedTransformColumn)
    ? selectedTransformColumn
    : numericColumns[0]?.name ?? '';
  const textColumns = edited.columns.filter((column) => column.type.toUpperCase() === 'TEXT');

  const buildTransform = (): { config: TransformConfig; label: string } => {
    const markers = markerList();
    if (transformTab === 'replace') {
      return {
        config: {
          kind: 'replace', column: selectedTransformColumn, find: findValue,
          replacement: replacementValue, match_mode: matchMode, match_case: matchCase,
          replace_all: replaceAll, markers,
        },
        label: `Replace ${replaceAll ? 'all ' : 'one '}${JSON.stringify(findValue)} with ${JSON.stringify(replacementValue)} in ${selectedTransformColumn}`,
      };
    }
    if (transformTab === 'missing') {
      if (missingAction === 'remove_rows') {
        return {
          config: { kind: 'remove_missing_rows', column: selectedTransformColumn || '*', markers },
          label: `Remove rows with missing values in ${selectedTransformColumn || 'any column'}`,
        };
      }
      if (missingAction === 'standardize_markers') {
        return {
          config: { kind: 'clean_missing_markers', column: selectedTransformColumn || '*', markers },
          label: `Standardize missing markers in ${selectedTransformColumn || 'all columns'}`,
        };
      }
      const column = selectedTransformColumn || '*';
      return {
        config: {
          kind: 'fill_missing', column,
          fill_mode: fillMode, replacement: replacementValue, markers,
        },
        label: `Replace missing ${fillMode === 'value' ? 'values' : fillMode} in ${column}`,
      };
    }
    if (transformTab === 'bulk') {
      if (!conditionValue.trim() && !['is empty', 'is not empty'].includes(conditionOperator)) {
        throw new Error('Enter a value for the condition.');
      }
      return {
        config: {
          kind: 'bulk_update',
          target_column: selectedTransformColumn,
          replacement: replacementValue,
          condition: {
            column: selectedConditionColumn,
            operator: conditionOperator,
            value: conditionValue,
            match_case: matchCase,
          },
          markers,
        },
        label: `Set ${selectedTransformColumn} where ${selectedConditionColumn} ${conditionOperator} ${conditionValue || '(empty)'}`,
      };
    }
    if (transformTab === 'columns') {
      const isConversion = columnAction === 'convert_type';
      if (columnAction === 'rename') {
        return {
          config: { kind: 'rename_column', column: selectedTransformColumn, new_name: transformOutputName },
          label: `Rename ${selectedTransformColumn} to ${transformOutputName || '(unnamed)'}`,
        };
      }
      if (columnAction === 'split') {
        return {
          config: {
            kind: 'split_column', column: selectedTransformColumn, delimiter: transformDelimiter,
            first_name: transformOutputName, second_name: transformSecondName,
          },
          label: `Split ${selectedTransformColumn} into ${transformOutputName || '(unnamed)'} and ${transformSecondName || '(unnamed)'}`,
        };
      }
      if (columnAction === 'combine') {
        if (combineColumns.length < 2) throw new Error('Select at least two columns to combine.');
        const sources = combineColumns;
        return {
          config: { kind: 'combine_columns', columns: sources, delimiter: transformDelimiter, new_name: transformOutputName },
          label: `Combine ${sources.join(' + ')} into ${transformOutputName || '(unnamed)'}`,
        };
      }
      if (columnAction === 'calculate') {
        return {
          config: { kind: 'calculate_column', expression: calculationExpression, new_name: transformOutputName },
          label: `Create calculated column ${transformOutputName || '(unnamed)'}: ${calculationExpression}`,
        };
      }
      return {
        config: {
          kind: columnAction === 'convert_type' ? 'convert_type' : 'column',
          action: columnAction,
          columns: [selectedTransformColumn],
          target_type: targetType,
          digits: Number(roundDigits), markers,
        },
        label: isConversion
          ? `Convert ${selectedTransformColumn} from ${edited.columns.find((column) => column.name === selectedTransformColumn)?.type} to ${targetType}`
          : `${columnAction === 'round' ? `Round to ${roundDigits} places` : `${columnAction} values`} in ${selectedTransformColumn}`,
      };
    }
    if (transformTab === 'cleaning') {
      if (cleaningPreset === 'flag_range') {
        return {
          config: {
            kind: 'flag_range',
            column: selectedNumericColumn,
            minimum: rangeMinimum === '' ? null : Number(rangeMinimum),
            maximum: rangeMaximum === '' ? null : Number(rangeMaximum),
            new_name: rangeFlagName,
          },
          label: `Flag ${selectedNumericColumn} values outside ${rangeMinimum || '-∞'} to ${rangeMaximum || '∞'}`,
        };
      }
      if (cleaningPreset === 'trim_text' || cleaningPreset === 'normalize_text') {
        if (!textColumns.length) throw new Error('There are no text columns to clean.');
        return {
          config: {
            kind: 'column',
            action: cleaningPreset === 'trim_text' ? 'trim' : 'normalize',
            columns: textColumns.map((column) => column.name),
            markers,
          },
          label: cleaningPreset === 'trim_text' ? 'Trim whitespace from text columns' : 'Normalize categorical text (trim and lowercase)',
        };
      }
      if (cleaningPreset === 'markers_to_null') {
        return { config: { kind: 'clean_missing_markers', column: '*', markers }, label: 'Standardize common missing markers to NULL' };
      }
      if (cleaningPreset === 'deduplicate') {
        return { config: { kind: 'remove_duplicates', markers }, label: 'Remove exact duplicate rows' };
      }
      if (!numericColumns.length) throw new Error('There are no numeric columns to fill.');
      const fillMode = cleaningPreset === 'missing_zero' ? 'value' : 'median';
      return {
        config: {
          kind: 'fill_missing',
          column: numericColumns.length === edited.columns.length ? '*' : numericColumns.map((column) => column.name),
          fill_mode: fillMode, replacement: '0', markers,
        },
        label: fillMode === 'value' ? 'Replace missing numeric values with zero' : 'Replace missing numeric values with the median',
      };
    }
    const kind = advancedOperation;
    return {
      config: {
        kind,
        ...(kind === 'remove_missing_rows' ? { column: '*' } : {}),
        markers,
      },
      label: kind === 'remove_duplicates'
        ? 'Remove exact duplicate rows'
        : kind === 'remove_missing_columns'
          ? 'Remove columns containing missing values'
          : 'Remove rows containing missing values',
    };
  };

  const createTransformPreview = async () => {
    setTransformBusy(true);
    setError('');
    setTransformPreview(null);
    setPreviewSignature('');
    try {
      const { config, label } = buildTransform();
      const preview = await api.previewEditorTransformation(dataset.id, config, activeOperations);
      setTransformPreview(preview);
      setTransformPreviewLabel(label);
      setPreviewSignature(JSON.stringify({ config, operations: activeOperations }));
      if (!preview.operations.length) {
        setError('No changes are needed for this transformation.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not preview the transformation.');
    } finally {
      setTransformBusy(false);
    }
  };

  const applyTransformation = () => {
    if (!transformPreview || (!transformPreview.operations.length && !transformPreview.inverse_operations.length)) return;
    let config: TransformConfig;
    try {
      ({ config } = buildTransform());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Transformation settings are invalid.');
      return;
    }
    if (previewSignature !== JSON.stringify({ config, operations: activeOperations })) {
      setError('The settings or staged edits changed after preview. Preview again before applying.');
      setTransformPreview(null);
      return;
    }
    const count = transformPreview.affected_cells
      ? `${transformPreview.affected_cells.toLocaleString()} cell${transformPreview.affected_cells === 1 ? '' : 's'}`
      : transformPreview.rows_removed
        ? `${transformPreview.rows_removed.toLocaleString()} row${transformPreview.rows_removed === 1 ? '' : 's'}`
        : transformPreview.columns_removed.length
          ? `${transformPreview.columns_removed.length.toLocaleString()} column${transformPreview.columns_removed.length === 1 ? '' : 's'}`
          : transformPreview.columns_added.length
            ? `${transformPreview.columns_added.length.toLocaleString()} column${transformPreview.columns_added.length === 1 ? '' : 's'}`
            : 'the selected column schema';
    if (!window.confirm(`Apply this transformation to ${count}? You can undo it before saving.`)) return;
    const { label } = buildTransform();
    const audit: TransformAudit = {
      operation: label,
      columns: transformPreview.columns,
      affected_cells: transformPreview.affected_cells,
      affected_rows: transformPreview.affected_rows,
      created_at: new Date().toISOString(),
    };
    push(transformPreview.operations, transformPreview.inverse_operations, label, audit);
    onToast(`Staged ${count} for ${label}.`);
    setTransformPreview(null);
    setTransformOpen(false);
  };

  const activeTransformAudit = () => history.slice(0, cursor)
    .flatMap((entry) => entry.audit ? [{
      operation: entry.audit.operation,
      columns: entry.audit.columns,
      affected_cells: entry.audit.affected_cells,
      affected_rows: entry.audit.affected_rows,
    }] : []);

  const saveChanges = async () => {
    if (!activeOperations.length) return;
    setBusy(true);
    setError('');
    try {
      const activeAudit = activeTransformAudit();
      const result = await api.saveEditorChanges(dataset.id, activeOperations, activeAudit);
      setHistory([]);
      setCursor(0);
      setOffset(0);
      if (activeAudit.length) {
        setSavedTransformHistory(await api.editorTransformationHistory(dataset.id));
      }
      onSaved(result.dataset);
      onToast(`Saved ${result.dataset.name}.`);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Changes were not saved.');
    } finally {
      setBusy(false);
    }
  };

  const saveAs = async () => {
    if (!saveAsName.trim()) {
      setError('Enter a name for the new dataset.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const created = await api.saveEditorAs(dataset.id, saveAsName, activeOperations, activeTransformAudit());
      setSaveAsName('');
      onSaved(created);
      onToast(`Created separate dataset ${created.name}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save a separate dataset.');
    } finally {
      setBusy(false);
    }
  };

  const discardChanges = () => {
    if (!dirty || !window.confirm('Discard all unsaved edits and restore the last saved working copy?')) return;
    setHistory([]);
    setCursor(0);
    setError('');
    setSelected(new Set());
  };

  const restoreOriginal = async () => {
    if (!window.confirm('Restore the original dataset contents in this working copy? The original dataset will remain unchanged. This replaces the working copy.')) return;
    setBusy(true);
    setError('');
    try {
      const restored = await api.restoreOriginal(dataset.id);
      setHistory([]);
      setCursor(0);
      setOffset(0);
      onSaved(restored);
      onToast('Working copy restored from the original dataset.');
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not restore the original dataset.');
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.downloadEditorCsv(dataset.id, activeOperations);
      saveBlob(result.blob, result.filename);
      onToast(dirty ? 'Downloaded the edited preview.' : 'Downloaded the saved working copy.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'CSV download failed.');
    } finally {
      setBusy(false);
    }
  };

  let rowDelta = 0;
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const operation of activeOperations) {
    if (operation.type === 'insert_rows') {
      for (const row of operation.rows) {
        const id = String(row.id);
        if (!deleted.delete(id)) added.add(id);
      }
    } else if (operation.type === 'delete_rows') {
      for (const idValue of operation.row_ids) {
        const id = String(idValue);
        if (!added.delete(id)) deleted.add(id);
      }
    }
  }
  rowDelta = added.size - deleted.size;
  const totalRows = Math.max(0, baseTotal + rowDelta);
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const localTransformHistory = history
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.audit)
    .reverse();

  return <div className="fixed inset-0 z-50 overflow-y-auto bg-[#080b13] text-slate-200">
    <div className="mx-auto flex min-h-screen max-w-[1800px] flex-col px-4 py-4 md:px-7">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-[10px] uppercase tracking-wider text-sky-300">Dataset editor · isolated working copy</p><h2 className="mt-1 text-lg font-semibold text-white">{dataset.name}</h2><p className="mt-1 text-[11px] text-slate-500">Edits are isolated from the original and become visible to analytics after saving.</p></div>
        <button onClick={requestClose} aria-label="Close dataset editor" className="rounded-lg border border-white/10 p-2 text-slate-400 hover:text-white"><X size={17} /></button>
      </header>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={undo} disabled={cursor === 0 || busy} title="Undo (Ctrl+Z)" className="editor-button" aria-label="Undo"><Undo2 size={14} />Undo</button>
        <button onClick={redo} disabled={cursor >= history.length || busy} title="Redo (Ctrl+Y or Ctrl+Shift+Z)" className="editor-button" aria-label="Redo"><Redo2 size={14} />Redo</button>
        <button onClick={addRow} disabled={busy || !edited.columns.length} className="editor-button"><FilePlus2 size={14} />Add row</button>
        <button onClick={deleteRows} disabled={busy || !selected.size} className="editor-button text-rose-300"><Trash2 size={14} />Delete selected ({selected.size})</button>
        <button onClick={renameColumn} disabled={busy || !edited.columns.length} className="editor-button"><Columns3 size={14} />Rename column</button>
        <button onClick={deleteColumn} disabled={busy || edited.columns.length <= 1} className="editor-button text-rose-300"><Trash2 size={14} />Delete column</button>
        <div className="flex items-center gap-1">
          <input value={newColumnName} onChange={(event) => setNewColumnName(event.target.value)} placeholder="New column name" aria-label="New column name" className="editor-input w-36" />
          <select value={newColumnType} onChange={(event) => setNewColumnType(event.target.value as typeof newColumnType)} aria-label="New column type" className="editor-input">
            <option value="TEXT">Text</option><option value="INTEGER">Integer</option><option value="REAL">Decimal</option><option value="BOOLEAN">Boolean</option><option value="DATE">Date</option>
          </select>
          <button onClick={addColumn} disabled={busy} className="editor-button"><Plus size={14} />Add column</button>
        </div>
        <button onClick={() => { setTransformOpen(true); setTransformPreview(null); setTransformTab('replace'); }} disabled={busy} className="editor-button editor-transform-button"><WandSparkles size={14} />Transform Data</button>
      </div>
      {transformOpen && <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/70 p-4 md:p-8" role="presentation">
        <section role="dialog" aria-modal="true" aria-labelledby="transform-title" className="my-auto w-full max-w-4xl overflow-hidden rounded-2xl border border-white/10 bg-[#0d1420] shadow-2xl">
          <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
            <div><p className="text-[10px] uppercase tracking-wider text-sky-300">Working copy · preview before apply</p><h3 id="transform-title" className="mt-1 text-lg font-semibold text-white">Transform Data</h3></div>
            <button onClick={() => { setTransformOpen(false); setTransformPreview(null); }} aria-label="Close Transform Data" className="rounded-lg border border-white/10 p-2 text-slate-400 hover:text-white"><X size={16} /></button>
          </header>
          <nav className="flex gap-1 overflow-x-auto border-b border-white/[0.07] px-4 py-2" aria-label="Transformation sections">
            {([
              ['replace', 'Find and Replace'],
              ['missing', 'Replace Missing Values'],
              ['bulk', 'Bulk Value Update'],
              ['columns', 'Column Transformations'],
              ['cleaning', 'Data Cleaning'],
              ['advanced', 'Advanced Operations'],
              ['history', 'Transformation History'],
            ] as Array<[TransformTab, string]>).map(([tab, label]) => <button key={tab} onClick={() => { setTransformTab(tab); setTransformPreview(null); setError(''); }} className={`shrink-0 rounded-md px-3 py-2 text-[10px] ${transformTab === tab ? 'bg-sky-400/15 text-sky-200' : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'}`}>{tab === 'history' && <HistoryIcon size={12} className="mr-1 inline" />}{label}</button>)}
          </nav>
          <div className="max-h-[65vh] overflow-y-auto p-5">
            {transformTab === 'replace' && <div className="space-y-4">
              <p className="text-xs leading-5 text-slate-400">Match whole values by default. Numeric exact matching compares numeric values, so 2 does not match 12, 20, or 2.5.</p>
              <label className="transform-field">Column<select aria-label="Transformation column" value={selectedTransformColumn} onChange={(event) => setTransformColumn(event.target.value)} className="editor-input"><option value="*">All columns</option>{edited.columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</select></label>
              <div className="grid gap-3 md:grid-cols-2"><label className="transform-field">Find<input aria-label="Value to find" value={findValue} onChange={(event) => setFindValue(event.target.value)} className="editor-input" placeholder="Exact value" /></label><label className="transform-field">Replace with<input aria-label="Replacement value" value={replacementValue} onChange={(event) => setReplacementValue(event.target.value)} className="editor-input" placeholder="New value (blank clears text)" /></label></div>
              <div className="flex flex-wrap gap-5 text-[11px] text-slate-400">
                <label className="flex items-center gap-2"><input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} />Match case</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={replaceAll} onChange={(event) => setReplaceAll(event.target.checked)} />Replace all (off replaces the first occurrence)</label>
                <label className="flex items-center gap-2">Match<select aria-label="Match mode" value={matchMode} onChange={(event) => setMatchMode(event.target.value as typeof matchMode)} className="editor-input"><option value="exact">Exact value</option><option value="contains">Contains text</option></select></label>
              </div>
            </div>}
            {transformTab === 'missing' && <div className="space-y-4">
              <p className="text-xs leading-5 text-slate-400">NULL, NaN, blank strings, and the markers below count as missing. “Unknown” is not treated as missing unless explicitly added as a marker.</p>
              <label className="transform-field">Action<select aria-label="Missing values action" value={missingAction} onChange={(event) => setMissingAction(event.target.value as typeof missingAction)} className="editor-input"><option value="fill">Replace missing values</option><option value="remove_rows">Remove rows with missing values</option><option value="standardize_markers">Convert missing markers to NULL</option></select></label>
              <label className="transform-field">Column<select aria-label="Missing values column" value={selectedTransformColumn} onChange={(event) => setTransformColumn(event.target.value)} className="editor-input"><option value="*">All columns</option>{edited.columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</select></label>
              {missingAction === 'fill' && <div className="grid gap-3 md:grid-cols-2"><label className="transform-field">Fill method<select aria-label="Missing value fill method" value={fillMode} onChange={(event) => setFillMode(event.target.value as typeof fillMode)} className="editor-input"><option value="value">Use a value</option><option value="mean">Mean (numeric)</option><option value="median">Median (numeric)</option><option value="mode">Mode (most frequent)</option></select></label>{fillMode === 'value' && <label className="transform-field">Replacement value<input aria-label="Missing value replacement" value={replacementValue} onChange={(event) => setReplacementValue(event.target.value)} className="editor-input" placeholder="e.g. 0 or Not provided" /></label>}</div>}
              <label className="transform-field">Missing markers (comma separated)<input aria-label="Missing markers" value={missingMarkers} onChange={(event) => setMissingMarkers(event.target.value)} className="editor-input" /></label>
              {fillMode === 'value' && missingAction === 'fill' && <p className="rounded-lg border border-amber-400/20 bg-amber-400/[0.04] p-3 text-[11px] leading-5 text-amber-200">Replacing missing values with a constant can change averages and distributions. Choose a numeric or categorical fill method appropriate for the selected column.</p>}
            </div>}
            {transformTab === 'bulk' && <div className="space-y-4">
              <p className="text-xs leading-5 text-slate-400">Rules are validated against the target column’s type. Preview matching rows before staging any update.</p>
              <div className="grid gap-3 md:grid-cols-2"><label className="transform-field">If this column<select aria-label="Condition column" value={selectedConditionColumn} onChange={(event) => setConditionColumn(event.target.value)} className="editor-input">{edited.columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</select></label><label className="transform-field">Condition<select aria-label="Condition operator" value={conditionOperator} onChange={(event) => setConditionOperator(event.target.value)} className="editor-input">{['equals', 'not equals', 'greater than', 'greater than or equal', 'less than', 'less than or equal', 'contains', 'is empty', 'is not empty'].map((operator) => <option key={operator}>{operator}</option>)}</select></label></div>
              {!['is empty', 'is not empty'].includes(conditionOperator) && <label className="transform-field">Condition value<input aria-label="Condition value" value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} className="editor-input" placeholder="e.g. 60 or Unknown" /></label>}
              <div className="grid gap-3 md:grid-cols-2"><label className="transform-field">Set this column<select aria-label="Update target column" value={selectedTransformColumn} onChange={(event) => setTransformColumn(event.target.value)} className="editor-input">{edited.columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</select></label><label className="transform-field">To value<input aria-label="Bulk replacement value" value={replacementValue} onChange={(event) => setReplacementValue(event.target.value)} className="editor-input" /></label></div>
              <label className="flex items-center gap-2 text-[11px] text-slate-400"><input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} />Match case for text conditions</label>
            </div>}
            {transformTab === 'columns' && <div className="space-y-4">
              <p className="text-xs leading-5 text-slate-400">Type conversions validate every value before applying. Calculated columns accept arithmetic only (column names, numbers, +, -, *, /, //, %, and **); arbitrary code is never executed.</p>
              {!['combine', 'calculate'].includes(columnAction) && <label className="transform-field">Column<select aria-label="Column to transform" value={selectedTransformColumn} onChange={(event) => setTransformColumn(event.target.value)} className="editor-input">{edited.columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</select></label>}
              <label className="transform-field">Operation<select aria-label="Column operation" value={columnAction} onChange={(event) => setColumnAction(event.target.value as typeof columnAction)} className="editor-input"><option value="trim">Trim leading/trailing whitespace</option><option value="uppercase">Convert to uppercase</option><option value="lowercase">Convert to lowercase</option><option value="round">Round numeric values</option><option value="convert_type">Convert column type</option><option value="rename">Rename column</option><option value="split">Split column by delimiter</option><option value="combine">Combine columns into a new column</option><option value="calculate">Create calculated column</option></select></label>
              {columnAction === 'convert_type' && <label className="transform-field">Convert to<select aria-label="Target column type" value={targetType} onChange={(event) => setTargetType(event.target.value as EditorType)} className="editor-input"><option value="TEXT">Text</option><option value="INTEGER">Integer</option><option value="REAL">Decimal</option><option value="BOOLEAN">Boolean</option><option value="DATE">Date</option></select></label>}
              {columnAction === 'round' && <label className="transform-field">Decimal places<input aria-label="Decimal places" type="number" min="-10" max="10" step="1" value={roundDigits} onChange={(event) => setRoundDigits(event.target.value)} className="editor-input" /></label>}
              {['rename', 'split', 'combine', 'calculate'].includes(columnAction) && <label className="transform-field">{columnAction === 'rename' ? 'New column name' : 'Output column name'}<input aria-label="Transform output column name" value={transformOutputName} onChange={(event) => setTransformOutputName(event.target.value)} className="editor-input" /></label>}
              {columnAction === 'split' && <><label className="transform-field">Second output column name<input aria-label="Second output column name" value={transformSecondName} onChange={(event) => setTransformSecondName(event.target.value)} className="editor-input" /></label><label className="transform-field">Delimiter<input aria-label="Split delimiter" value={transformDelimiter} onChange={(event) => setTransformDelimiter(event.target.value)} className="editor-input" /></label></>}
              {columnAction === 'combine' && <><label className="transform-field">Columns to combine<select aria-label="Columns to combine" multiple value={combineColumns} onChange={(event) => setCombineColumns(Array.from(event.target.selectedOptions, (option) => option.value))} className="editor-input min-h-24">{edited.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label><label className="transform-field">Delimiter<input aria-label="Combine delimiter" value={transformDelimiter} onChange={(event) => setTransformDelimiter(event.target.value)} className="editor-input" /></label></>}
              {columnAction === 'calculate' && <label className="transform-field">Arithmetic expression<input aria-label="Calculated column expression" value={calculationExpression} onChange={(event) => setCalculationExpression(event.target.value)} placeholder="age * 2 + score" className="editor-input" /></label>}
              {columnAction === 'round' && !['INTEGER', 'REAL'].includes(edited.columns.find((column) => column.name === selectedTransformColumn)?.type.toUpperCase() ?? '') && <p role="alert" className="text-xs text-amber-200">Rounding only changes values that can be interpreted as numbers.</p>}
            </div>}
            {transformTab === 'cleaning' && <div className="space-y-4">
              <p className="text-xs leading-5 text-slate-400">Choose a preset, review its impact, then apply. Presets do not change the original dataset.</p>
              <label className="transform-field">Preset<select aria-label="Data cleaning preset" value={cleaningPreset} onChange={(event) => setCleaningPreset(event.target.value)} className="editor-input"><option value="trim_text">Trim whitespace in text columns</option><option value="normalize_text">Normalize categorical text (trim + lowercase)</option><option value="markers_to_null">Standardize missing markers to NULL</option><option value="missing_zero">Replace missing numeric values with zero</option><option value="missing_median">Replace missing numeric values with median</option><option value="deduplicate">Remove exact duplicate rows</option><option value="flag_range">Flag values outside a numeric range</option></select></label>
              {cleaningPreset === 'flag_range' && <><label className="transform-field">Numeric column<select aria-label="Numeric range column" value={selectedNumericColumn} onChange={(event) => setTransformColumn(event.target.value)} className="editor-input">{numericColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label><div className="grid gap-3 md:grid-cols-2"><label className="transform-field">Minimum (optional)<input aria-label="Range minimum" type="number" step="any" value={rangeMinimum} onChange={(event) => setRangeMinimum(event.target.value)} className="editor-input" /></label><label className="transform-field">Maximum (optional)<input aria-label="Range maximum" type="number" step="any" value={rangeMaximum} onChange={(event) => setRangeMaximum(event.target.value)} className="editor-input" /></label></div><label className="transform-field">Review flag column<input aria-label="Review flag column" value={rangeFlagName} onChange={(event) => setRangeFlagName(event.target.value)} className="editor-input" /></label><p className="text-[10px] text-slate-400">Rows outside the selected range will be marked “Review”; values are not changed.</p></>}
              {cleaningPreset === 'missing_zero' && <p className="rounded-lg border border-amber-400/20 bg-amber-400/[0.04] p-3 text-[11px] leading-5 text-amber-200">Zero may be a meaningful value and can bias summary statistics. This preset targets numeric columns only; inspect the preview before applying.</p>}
              {cleaningPreset === 'missing_median' && <p className="rounded-lg border border-sky-400/20 bg-sky-400/[0.04] p-3 text-[11px] leading-5 text-sky-200">Median imputation can reduce missingness but changes the distribution. Only numeric columns are included.</p>}
              <p className="text-[10px] text-slate-500">Eligible text columns: {textColumns.map((column) => column.name).join(', ') || 'none'} · numeric columns: {numericColumns.map((column) => column.name).join(', ') || 'none'}</p>
              <label className="transform-field">Missing markers<input aria-label="Cleaning missing markers" value={missingMarkers} onChange={(event) => setMissingMarkers(event.target.value)} className="editor-input" /></label>
            </div>}
            {transformTab === 'advanced' && <div className="space-y-4">
              <p className="text-xs leading-5 text-slate-400">Destructive row operations show a count and sample preview and require confirmation before staging.</p>
              <label className="transform-field">Operation<select aria-label="Advanced operation" value={advancedOperation} onChange={(event) => setAdvancedOperation(event.target.value as typeof advancedOperation)} className="editor-input"><option value="remove_missing_rows">Remove rows containing missing values</option><option value="remove_duplicates">Remove exact duplicate rows</option><option value="remove_missing_columns">Remove columns containing missing values</option></select></label>
              <label className="transform-field">Missing markers<input aria-label="Advanced missing markers" value={missingMarkers} onChange={(event) => setMissingMarkers(event.target.value)} className="editor-input" /></label>
            </div>}
            {transformTab === 'history' && <div className="space-y-5">
              <div><h4 className="mb-2 text-xs font-semibold text-white">Current session</h4>{localTransformHistory.length ? <div className="space-y-2">{localTransformHistory.map((entry) => <div key={entry.index} className="rounded-lg border border-white/[0.07] p-3"><div className="flex items-start justify-between gap-3"><p className="text-xs text-slate-200">{entry.audit?.operation}</p><span className={`shrink-0 rounded-full px-2 py-1 text-[9px] ${entry.index < cursor ? 'bg-emerald-400/10 text-emerald-300' : 'bg-slate-400/10 text-slate-400'}`}>{entry.index < cursor ? `Applied${entry.index === cursor - 1 ? ' · undo available' : ''}` : `Undone${entry.index === cursor ? ' · redo available' : ''}`}</span></div><p className="mt-1 text-[10px] text-slate-500">{entry.audit?.columns.join(', ')} · {entry.audit?.affected_cells.toLocaleString()} cells · {entry.audit?.affected_rows.toLocaleString()} rows · {new Date(entry.audit?.created_at ?? '').toLocaleString()}</p></div>)}</div> : <p className="text-[11px] text-slate-500">No transformations in this editing session.</p>}</div>
              <div><h4 className="mb-2 text-xs font-semibold text-white">Saved transformation history</h4>{savedTransformHistory.length ? <div className="space-y-2">{savedTransformHistory.map((entry, index) => <div key={`${entry.created_at}-${index}`} className="rounded-lg border border-white/[0.07] p-3"><div className="flex items-start justify-between gap-3"><p className="text-xs text-slate-200">{entry.operation}</p><span className="rounded-full bg-sky-400/10 px-2 py-1 text-[9px] text-sky-300">Saved</span></div><p className="mt-1 text-[10px] text-slate-500">{entry.columns.join(', ')} · {entry.affected_cells.toLocaleString()} cells · {entry.affected_rows.toLocaleString()} rows · {new Date(entry.created_at).toLocaleString()}</p><p className="mt-1 text-[9px] text-slate-600">Saved audit entry only; undo history is limited to the current editor session.</p></div>)}</div> : <p className="text-[11px] text-slate-500">Saved transformation history will appear here after Save Changes.</p>}</div>
            </div>}
            {error && <p role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/[0.05] p-3 text-xs text-rose-200">{error}</p>}
            {transformTab !== 'history' && transformPreview && <section className="mt-5 rounded-xl border border-sky-400/20 bg-sky-400/[0.035] p-4" aria-label="Transformation preview">
              <div className="flex items-start justify-between gap-3"><div><h4 className="text-sm font-semibold text-white">Preview</h4><p className="mt-1 text-[10px] text-slate-300">{transformPreviewLabel}</p><p className="mt-1 text-[10px] text-slate-400">Columns: {transformPreview.columns.join(', ') || '(none)'}</p></div><span className="rounded-full bg-sky-400/10 px-2 py-1 text-[10px] text-sky-200">{transformPreview.affected_cells.toLocaleString()} cells · {transformPreview.affected_rows.toLocaleString()} rows</span></div>
              <p className="mt-2 text-[10px] text-slate-500">Rows: {totalRows.toLocaleString()} → {Math.max(0, totalRows - transformPreview.rows_removed).toLocaleString()} · Columns: {edited.columns.length.toLocaleString()} → {Math.max(0, edited.columns.length + transformPreview.columns_added.length - transformPreview.columns_removed.length).toLocaleString()}{transformPreview.rows_removed ? ` (${transformPreview.rows_removed.toLocaleString()} removed)` : ''}{transformPreview.columns_added.length ? ` · ${transformPreview.columns_added.join(', ')} added` : ''}{transformPreview.columns_removed.length ? ` · ${transformPreview.columns_removed.join(', ')} removed` : ''}</p>
              {transformPreview.type_changes.map((change) => <p key={change.column} className="mt-2 text-[10px] text-sky-200">Type change: {change.column} · {change.from} → {change.to}</p>)}
              {transformPreview.warnings.map((warning) => <p key={warning} className="mt-2 flex gap-2 text-[10px] text-amber-200"><AlertTriangle size={13} className="shrink-0" />{warning}</p>)}
              <div className="mt-3 max-h-48 overflow-auto rounded-lg border border-white/[0.06]"><table className="w-full text-left text-[10px]"><thead className="sticky top-0 bg-[#111827] text-slate-400"><tr><th className="p-2">Column</th><th className="p-2">Before</th><th className="p-2">After</th></tr></thead><tbody>{transformPreview.examples.map((example, index) => <tr key={`${String(example.row_id)}-${example.column}-${index}`} className="border-t border-white/[0.05]"><td className="p-2 text-slate-300">{example.column}</td><td className="max-w-64 truncate p-2 text-rose-200">{example.before === null ? 'NULL' : String(example.before)}</td><td className="max-w-64 truncate p-2 text-emerald-200">{example.after === null ? 'NULL' : String(example.after)}</td></tr>)}</tbody></table></div>
              {transformPreview.affected_cells + transformPreview.rows_removed > transformPreview.examples.length && <p className="mt-2 text-[9px] text-slate-500">Showing up to {transformPreview.examples.length} examples. The full operation is undoable as one action.</p>}
            </section>}
          </div>
          <footer className="flex flex-wrap justify-end gap-2 border-t border-white/[0.07] px-5 py-4">
            <button onClick={() => { setTransformOpen(false); setTransformPreview(null); }} className="editor-button">Cancel</button>
            {transformTab !== 'history' && !transformPreview && <button onClick={() => void createTransformPreview()} disabled={transformBusy || !edited.columns.length} className="editor-button editor-primary">{transformBusy ? <LoaderCircle size={14} className="animate-spin" /> : <Search size={14} />}Preview transformation</button>}
            {transformTab !== 'history' && transformPreview && <><button onClick={() => { setTransformPreview(null); setPreviewSignature(''); }} className="editor-button">Edit settings</button><button onClick={applyTransformation} disabled={!transformPreview.operations.length} className="editor-button editor-primary"><Check size={14} />Apply Transformation</button></>}
          </footer>
        </section>
      </div>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[10px] text-slate-500"><Search size={13} /><input value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder="Search all columns" aria-label="Search dataset records" className="editor-input w-44" /></label>
        <select value={filterColumn} onChange={(event) => { setFilterColumn(event.target.value); setOffset(0); }} aria-label="Filter column" className="editor-input"><option value="">Filter column…</option>{edited.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select>
        <input value={filterValue} onChange={(event) => { setFilterValue(event.target.value); setOffset(0); }} placeholder="Contains value…" aria-label="Filter value" className="editor-input w-36" />
        {(search || filterValue) && <button onClick={() => { setSearch(''); setFilterValue(''); setFilterColumn(''); setOffset(0); }} className="text-[10px] text-sky-300">Clear filters</button>}
        <div className="ml-auto flex items-center gap-2">
          <span role="status" className={`rounded-full px-2 py-1 text-[10px] ${dirty ? 'bg-amber-400/10 text-amber-300' : 'bg-emerald-400/10 text-emerald-300'}`}>{dirty ? `${cursor} unsaved edit${cursor === 1 ? '' : 's'}` : 'All changes saved'}</span>
          <span className="text-[10px] text-slate-500">{totalRows.toLocaleString()} rows · {edited.columns.length} columns</span>
        </div>
      </div>
      {error && <p role="alert" className="mb-3 rounded-lg border border-rose-400/20 bg-rose-400/[0.05] p-3 text-xs text-rose-200">{error}</p>}
      <div className="editor-grid relative min-h-[300px] flex-1 overflow-hidden rounded-lg border border-white/10">
        {busy && <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/20"><LoaderCircle className="animate-spin text-sky-300" size={24} /></div>}
        {edited.rows.length ? <DataGrid
          aria-label="Editable dataset spreadsheet"
          columns={gridColumns}
          rows={edited.rows}
          rowKeyGetter={(row) => String(row[rowKey])}
          onRowsChange={onRowsChange}
          selectedRows={selected}
          onSelectedRowsChange={(next) => setSelected(new Set(Array.from(next, String)))}
          sortColumns={sortColumns}
          onSortColumnsChange={(next) => { setSortColumns(next.slice(-1)); setOffset(0); }}
          defaultColumnOptions={{ resizable: true }}
          className="rdg-dark"
          style={{ height: '100%' }}
        /> : <div className="p-8 text-center text-xs text-slate-500">No matching records.</div>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))} disabled={offset === 0 || busy} className="editor-button"><ArrowUp size={13} />Previous</button>
        <span className="text-[10px] text-slate-500">Page {Math.min(Math.floor(offset / PAGE_SIZE) + 1, pageCount)} of {pageCount} · {baseTotal.toLocaleString()} saved rows</span>
        <button onClick={() => setOffset((value) => value + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= baseTotal || busy} className="editor-button"><ArrowDown size={13} />Next</button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button onClick={discardChanges} disabled={!dirty || busy} className="editor-button text-rose-300"><RotateCcw size={13} />Discard changes</button>
          <button onClick={restoreOriginal} disabled={busy} className="editor-button"><RotateCcw size={13} />Restore Original</button>
          <button onClick={downloadCsv} disabled={busy} className="editor-button"><Download size={13} />Download CSV</button>
          <button onClick={saveChanges} disabled={!dirty || busy} className="editor-button editor-primary"><Save size={13} />Save Changes</button>
        </div>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void saveAs(); }} className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] pt-3">
        <input value={saveAsName} onChange={(event) => setSaveAsName(event.target.value)} placeholder="New dataset name" aria-label="New dataset name" className="editor-input w-52" />
        <button type="submit" disabled={busy || !saveAsName.trim()} className="editor-button"><Check size={13} />Save As New Dataset</button>
      </form>
      <p className="mt-2 text-right text-[9px] text-slate-600">Edit cells by double-clicking or pressing Enter. Rows are paged to limit data transfer. Undo history is limited to {MAX_HISTORY} actions.</p>
    </div>
  </div>;
}
