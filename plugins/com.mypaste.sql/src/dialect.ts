/**
 * The seven SQL dialects this page understands.
 *
 * A dialect is not a mode switch on one grammar: each one brings its own
 * keyword and type vocabulary, its own way of quoting an identifier, and its
 * own literal forms. The words here are the page's words — the settings that
 * used to select a dialect are gone, so the picker in the toolbar is the one
 * owner of the choice.
 *
 * Nothing in this module executes SQL. The vocabulary only decides how a word
 * is painted and how the formatter may lay it out.
 */

export type Dialect =
  | "ansi"
  | "postgresql"
  | "mysql"
  | "sqlite"
  | "tsql"
  | "plsql"
  | "bigquery";

export interface DialectInfo {
  readonly id: Dialect;
  /** The label the picker shows. */
  readonly label: string;
  /** Words that are grammar, not names. */
  readonly keywords: ReadonlySet<string>;
  /** Type names; painted as types, not as keywords. */
  readonly types: ReadonlySet<string>;
  /** Constants such as TRUE and NULL, painted as literals. */
  readonly literals: ReadonlySet<string>;
  /** Bracket character that opens a quoted identifier, if the dialect has one. */
  readonly bracketIdentifier: "[" | null;
  /** Whether double quotes carry an identifier (true) or a string (false). */
  readonly doubleQuotedIdentifier: boolean;
  /** Whether backticks carry an identifier. */
  readonly backtickIdentifier: boolean;
  /** Whether `#` starts a line comment. */
  readonly hashComment: boolean;
  /** Whether a backslash escapes the next character inside a string. */
  readonly backslashEscapes: boolean;
  /** Whether `E'…'` introduces an escape string. */
  readonly escapeStringPrefix: boolean;
  /** Whether `N'…'` introduces a national string. */
  readonly nationalStringPrefix: boolean;
  /** Whether `$tag$…$tag$` introduces a dollar-quoted string. */
  readonly dollarQuoted: boolean;
}

const COMMON_KEYWORDS = `
  ADD ALL ALTER AND ANY AS ASC BEGIN BETWEEN BY CASCADE CASE CAST CHECK
  COLLATE COLUMN COMMENT COMMIT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE
  CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DATABASE DEFAULT DELETE DESC
  DISTINCT DO DROP ELSE END ESCAPE EXCEPT EXISTS EXPLAIN FALSE FETCH FIRST
  FOR FOREIGN FROM FULL FUNCTION GRANT GROUP HAVING IF IN INDEX INNER INSERT
  INTERSECT INTO IS JOIN KEY LAST LEFT LIKE LIMIT NATURAL NOT NULL OFFSET ON
  ONLY OR ORDER OUTER OVER PARTITION PRIMARY REFERENCES RETURNING REVOKE
  RIGHT ROLLBACK ROW ROWS SCHEMA SELECT SET TABLE THEN TO TRANSACTION TRUE
  TRUNCATE UNION UNIQUE UPDATE USING VALUES VIEW WHEN WHERE WINDOW WITH
  ABS AVG COALESCE CONCAT COUNT LOWER MAX MIN NOW NULLIF ROUND SUM UPPER
`;

const COMMON_TYPES = `
  BIGINT BINARY BIT BLOB BOOLEAN CHAR CHARACTER CLOB DATE DATETIME DECIMAL
  DOUBLE FLOAT INT INTEGER INTERVAL JSON MONEY NCHAR NUMERIC NVARCHAR REAL
  SMALLINT TEXT TIME TIMESTAMP TINYINT UUID VARBINARY VARCHAR XML
`;

const COMMON_LITERALS = "TRUE FALSE NULL";

function words(source: string): ReadonlySet<string> {
  return new Set(source.trim().split(/\s+/));
}

const baseKeywords = words(COMMON_KEYWORDS);
const baseTypes = words(COMMON_TYPES);
const baseLiterals = words(COMMON_LITERALS);

function make(
  id: Dialect,
  label: string,
  extraKeywords: string,
  options: Partial<Omit<DialectInfo, "id" | "label" | "keywords" | "types" | "literals">> & {
    types?: string;
  } = {},
): DialectInfo {
  return {
    id,
    label,
    keywords: words(`${COMMON_KEYWORDS} ${extraKeywords}`),
    types: words(`${COMMON_TYPES} ${options.types ?? ""}`),
    literals: baseLiterals,
    bracketIdentifier: options.bracketIdentifier ?? null,
    doubleQuotedIdentifier: options.doubleQuotedIdentifier ?? true,
    backtickIdentifier: options.backtickIdentifier ?? false,
    hashComment: options.hashComment ?? false,
    backslashEscapes: options.backslashEscapes ?? false,
    escapeStringPrefix: options.escapeStringPrefix ?? false,
    nationalStringPrefix: options.nationalStringPrefix ?? false,
    dollarQuoted: options.dollarQuoted ?? false,
  };
}

export const DIALECTS: readonly DialectInfo[] = [
  make("ansi", "SQL 标准", "", { doubleQuotedIdentifier: true }),
  make(
    "postgresql",
    "PostgreSQL",
    `ALL ANALYSE ANALYZE ARRAY ASYMMETRIC AUTHORIZATION BOTH CONCURRENTLY
     DEFERRABLE DEFERRED EXCLUDE FILTER FREEZE ILIKE LATERAL LEADING MATERIALIZED
     NOTHING NULLS OVERLAPS PLACING PROCEDURE RANGE REINDEX REPLACE RULE
     SESSION SIMILAR SYMMETRIC TABLESAMPLE TRAILING VACUUM VARIADIC VERBOSE
     CONFLICT DO`,
    {
      types: "SERIAL BIGSERIAL SMALLSERIAL BYTEA CIDR INET MACADDR TSVECTOR TSQUERY JSONB",
      dollarQuoted: true,
      escapeStringPrefix: true,
      backslashEscapes: true,
    },
  ),
  make(
    "mysql",
    "MySQL",
    `ACCESSIBLE ANALYZE AUTO_INCREMENT BINARY CACHE CHANGE CHARACTER CHARSET
     COLLATION COLUMNS DATABASES DAY_HOUR DELAYED DESCRIBE DISTINCTROW DIV
     DUAL ENGINE ENGINES ESCAPED FLUSH FORCE FULLTEXT GENERATED HIGH_PRIORITY
     IGNORE INFILE INOUT KEYS KILL LINES LOAD LOCK LONG LOW_PRIORITY
     MASTER MODIFY OPTIMIZE OPTION OPTIONALLY OUTFILE PACK_KEYS PARTITIONS
     PURGE QUICK READ REFERENCES REGEXP RENAME REPAIR REQUIRE RESET RESTRICT
     RLIKE SHOW SPATIAL SQL_CALC_FOUND_ROWS SSL STARTING STRAIGHT_JOIN
     TERMINATED UNLOCK UNSIGNED USE UTC_DATE UTC_TIME UTC_TIMESTAMP VARBINARY
     VARCHARACTER WHILE XOR YEAR_MONTH ZEROFILL`,
    {
      types:
        "TINYTEXT MEDIUMTEXT LONGTEXT TINYBLOB MEDIUMBLOB LONGBLOB",
      backtickIdentifier: true,
      doubleQuotedIdentifier: false,
      hashComment: true,
      backslashEscapes: true,
      nationalStringPrefix: true,
    },
  ),
  make(
    "sqlite",
    "SQLite",
    `ABORT ACTION AFTER ATTACH AUTOINCREMENT BEFORE CAST CONFLICT DETACH
     EXCLUSIVE FAIL GLOB INDEXED INSTEAD ISNULL NOTNULL PLAN PRAGMA QUERY
     RAISE RECURSIVE RELEASE SAVEPOINT TEMP TEMPORARY VACUUM VIRTUAL WITHOUT
     RENAME REPLACE STRICT`,
    { bracketIdentifier: "[", backtickIdentifier: true, doubleQuotedIdentifier: true },
  ),
  make(
    "tsql",
    "SQL Server",
    `ANSI_NULLS BROWSE BULK CHECKPOINT CLUSTERED COMPUTE CONTAINS CONTAINSTABLE
     DBCC DENY DISK DISTRIBUTED DUMP ERRLVL EXIT FILE FILLFACTOR FREETEXT
     FREETEXTTABLE HOLDLOCK IDENTITY IDENTITY_INSERT IDENTITYCOL KILL LINENO
     MERGE NOCHECK NONCLUSTERED OFFSETS OPENJSON OPENROWSET OPENXML OPTION
     PERCENT PIVOT PRINT PROC PROCEDURE RAISERROR READTEXT RECONFIGURE
     REPLICATION RESTORE ROWCOUNT ROWGUIDCOL SAVE SECURITYAUDIT SETUSER SHUTDOWN
     STATISTICS TEXTSIZE TOP TRAN TRY_CONVERT TRY_CAST TSEQUAL UNPIVOT UPDATETEXT
     WAITFOR WRITETEXT GO`,
    {
      types:
        "NVARCHAR NTEXT IMAGE DATETIME2 DATETIMEOFFSET SMALLDATETIME UNIQUEIDENTIFIER",
      bracketIdentifier: "[",
      doubleQuotedIdentifier: true,
      nationalStringPrefix: true,
    },
  ),
  make(
    "plsql",
    "Oracle PL/SQL",
    `ACCESS BODY BULK COLLECT COMPOUND CONSTANT CURSOR DECLARE EXCEPTION
     EXECUTE FORCE LOOP MINUS NOCOPY PACKAGE PARALLEL PCTFREE PIPELINED
     PRAGMA RAISE RECORD REPLACE SAVEPOINT SEQUENCE SYNONYM TRIGGER TYPE`,
    {
      types:
        "VARCHAR2 NVARCHAR2 NUMBER BINARY_FLOAT BINARY_DOUBLE ROWID UROWID XMLTYPE CLOB NCLOB BLOB BFILE RAW",
      doubleQuotedIdentifier: true,
    },
  ),
  make(
    "bigquery",
    "BigQuery",
    `ANY_VALUE APPROX_COUNT_DISTINCT APPROX_QUANTILES ARRAY ARRAY_AGG
     ARRAY_CONCAT ASSERT_ROWS_MODIFIED AT CLUSTER CONTAINS
     CUBE CUME_DIST DENSE_RANK DESCRIPTOR DISTINCT ENUM EXTRACT FORMAT GENERATE
     GROUPING GROUPS HASH IGNORE IFNULL INNER INTERLEAVE JSON_EXTRACT
     JSON_EXTRACT_SCALAR JSON_QUERY JSON_VALUE LAST_VALUE LATERAL LEAD LAG
     NTH_VALUE NTILE NULLIF SAFE_CAST SAFE_DIVIDE TABLESAMPLE THRESHOLD
     UNNEST UNIQUE WINDOW QUALIFY PIVOT UNPIVOT ZONE`,
    {
      types: "BIGNUMERIC BYTES NUMERIC JSON GEOGRAPHY STRUCT",
      backtickIdentifier: true,
      doubleQuotedIdentifier: false,
    },
  ),
];

const BY_ID = new Map<Dialect, DialectInfo>(DIALECTS.map((dialect) => [dialect.id, dialect]));

/** The dialect of a picker value; anything unknown resolves to ANSI. */
export function dialectById(value: string): DialectInfo {
  return BY_ID.get(value as Dialect) ?? BY_ID.get("ansi")!;
}

/** The closed set of dialect words, for validation and tests. */
export const DIALECT_IDS: readonly string[] = DIALECTS.map((dialect) => dialect.id);

export { baseKeywords, baseTypes, baseLiterals };
