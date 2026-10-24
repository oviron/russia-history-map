"""Сборка данных карты из Cliopatria (Seshat, CC BY 4.0) и Natural Earth.

Запуск: uv run --with shapely --with pyproj python build/build.py <cliopatria.geojson> <ne-dir> <out-dir>

Пишет out-dir/raw.geojson: слои state (территория российского государства),
overlay (оккупации противником, автономии, непризнанные аннексии) и context (соседи).
Упрощение и TopoJSON — mapshaper в build/build.sh.
"""
import json
import sys
from collections import defaultdict

from pyproj import Transformer
import shapely
from shapely import set_precision
from shapely.affinity import translate
from shapely.geometry import Point, box, mapping, shape
from shapely.ops import unary_union

SRC, NE, OUT = sys.argv[1:4]
YEAR_MIN, YEAR_MAX, DATA_MAX = 862, 2026, 2024
EMPTY = shape({'type': 'Polygon', 'coordinates': []})

# Регион карты: Евразия до Атлантики плюс Аляска; полоса за 180° — для восточной Чукотки,
# сдвинутой на +360° (см. ниже).
REGION = unary_union([box(-25, 10, 180, 85), box(-180, 45, -125, 75), box(180, 60, 192, 75)])

# Cliopatria обрезает полигоны по 180-му меридиану и теряет всё, что восточнее: Чукотку от
# Уэлена до Провидения. Достраиваем её по суше Natural Earth, сдвинув на +360°, чтобы она
# слилась с западной частью в один полигон без шва.
# Остров Святого Лаврентия (США) лежит южнее 63,95° с. ш., Малый Диомид — восточнее 169° з. д.
# Острова Врангеля и Геральд в Cliopatria нет совсем: советский флаг на Врангеле поднят в 1924 г.
LAND = unary_union([shape(f['geometry']).buffer(0) for f in json.load(open(f'{NE}/ne_50m_land.geojson'))['features']])
CHUKOTKA_E = translate(LAND.intersection(box(-180, 63.95, -169.0, 70.5)), xoff=360)
WRANGEL = LAND.intersection(box(178, 70.5, 180, 72)).union(
    translate(LAND.intersection(box(-180, 70.5, -175, 72)), xoff=360))

recs = defaultdict(list)
for f in json.load(open(SRC))['features']:
    p = f['properties']
    recs[p['Name']].append((p['FromYear'], p['ToYear'], f))
for v in recs.values():
    v.sort(key=lambda r: r[0])

_geom_cache = {}


def rec(name, year):
    """Геометрия записи полития name, действующей в year (или пустая)."""
    for a, b, f in recs[name]:
        if a <= year <= b:
            key = (name, a)
            if key not in _geom_cache:
                _geom_cache[key] = shape(f['geometry']).buffer(0)
            return _geom_cache[key]
    return EMPTY


def diff_part(name_a, year_a, name_b, year_b, bbox):
    """Что есть у записи A и нет у записи B, в пределах bbox (lon0, lat0, lon1, lat1)."""
    return rec(name_a, year_a).difference(rec(name_b, year_b)).intersection(box(*bbox))


KR, GPM, TS, RE = "Kievan Rus'", 'Grand Principality of Moscow', 'Tsardom of Russia', 'Russian Empire'
RR, RSU, USSR = 'Russian Republic', 'Republics of the Soviet Union', 'Union of Soviet Socialist Republics'

# Линия государства: какой политий Cliopatria считается Россией в данный год.
LINEAGE = [
    (880, 881, "Rus'"),
    (882, 1240, 'RUS_LANDS'),
    (1294, 1546, GPM),
    (1547, 1720, TS),
    (1721, 1916, RE),
    (1917, 1917, RR),
    (1918, 1919, 'CIVIL_WAR'),
    (1920, 1921, RSU),
    (1922, 1991, USSR),
    (1992, YEAR_MAX, 'Russian Federation'),
]

STATE_LABEL = [
    (862, 881, 'Русь'),
    (882, 1131, 'Древнерусское государство (Киевская Русь)'),
    (1132, 1240, 'Русские земли (период раздробленности)'),
    (1294, 1546, 'Великое княжество Московское'),
    (1547, 1720, 'Русское царство'),
    (1721, 1916, 'Российская империя'),
    (1917, 1917, 'Российская республика'),
    (1918, 1921, 'Советская Россия и территории Гражданской войны'),
    (1922, 1991, 'СССР'),
    (1992, YEAR_MAX, 'Российская Федерация'),
]

RUS_PRINCIPALITIES = [
    'Principality of Kiev', 'Principality of Rostov-Suzdal', 'Principality of Chernigov',
    'Principality of Smolensk', 'Principality of Polotsky', 'Novgorod Republic',
    'Principality of Ryazan', 'Principality of Galicia-Volhynia', 'Pskov Republic', 'Tver', 'Ryazan',
    'Nizhny Novgorod', 'Principality of Vladimir-Suzdal', 'Galicia-Volhynia', 'Principality of Minsk',
    'Principality of Pereyaslavl', 'Principality of Halych', 'Principality of Volhynia', 'Principality of Peremyshl',
]
# Земли под властью царя, которые Cliopatria ведёт отдельными политиями.
UNDER_TSAR = [
    (1662, 1774, 'Zaporozhian Cossacks'),  # Гетманщина и Запорожье
    (1670, 1768, 'Sloboda Ukraine'),       # Слободская Украина
]
EXCLUDE_CONTEXT = ({n for _, _, n in LINEAGE} | {n for _, _, n in UNDER_TSAR}
                   | {'Russian-occupied territories'})
INTERWAR_NEIGHBOURS = ['Republic of Finland', 'Republic of Estonia', 'Republic of Latvia', 'Kingdom of Lithuania',
                       'Second Polish Republic', 'Kingdom of Romania', 'Romania']


def lineage_raw(year):
    y = min(year, DATA_MAX)
    for a, b, name in LINEAGE:
        if not a <= year <= b:
            continue
        if name == 'RUS_LANDS':
            # Киевская Русь в Cliopatria не включает часть княжеств (Рязань и др.),
            # поэтому берём объединение Руси и всех русских княжеств года.
            return unary_union([rec(KR, y) if y <= 1235 else EMPTY] + [rec(n, y) for n in RUS_PRINCIPALITIES])
        if name == 'CIVIL_WAR':
            # В Cliopatria на 1918–1919 есть только белые правительства («Russian Republic»),
            # центр с Москвой не покрыт ничем. Берём Российскую республику 1917 года
            # за вычетом всего, что в этот год принадлежит другим политиям.
            others = [rec(n, y) for n in recs if n not in EXCLUDE_CONTEXT and not n.startswith('(')]
            others = [g for g in others if not g.is_empty and g.intersects(rec(RR, 1917))]
            return rec(RR, 1917).difference(unary_union(others))
        g = rec(name, y)
        for a2, b2, n2 in UNDER_TSAR:
            if a2 <= year <= b2:
                g = g.union(rec(n2, y))
        if 1920 <= year <= 1939:
            # В межвоенные годы контур СССР в данных заходит на соседей (Абрене, Печоры).
            g = g.difference(unary_union([rec(n, y) for n in INTERWAR_NEIGHBOURS]))
        return g
    return None


TUVA = diff_part(RE, 1914, RE, 1913, (88, 49, 100, 54))
DANUBE = (20, 42, 30.6, 48.6)  # Молдавия и Валахия

# Исправления данных. remove — Cliopatria записала военную оккупацию или зону влияния
# как территорию либо держит территорию дольше договора; add — территория принадлежала,
# а в данных её нет (сдвиг даты, пропуск). Правило: (от, до, геометрия(year), пояснение).
REMOVE = [
    (972, 979, lambda y: diff_part(KR, y, KR, 980, (20, 40, 31, 46.5)), 'Дунайская Болгария: Святослав ушёл в 971 г.'),
    (1475, 1477, lambda y: rec('Novgorod Republic', y), 'Новгород присоединён в 1478 г.'),
    (1572, 1578, lambda y: diff_part(TS, y, TS, 1571, (28, 54, 32, 55.3)), 'Витебщина Иваном IV не взята'),
    (1582, 1587, lambda y: diff_part(TS, y, TS, 1588, (20, 55.5, 28.1, 60.5)), 'Ливония: отказ по Ям-Запольскому миру 1582 г.'),
    (1617, 1618, lambda y: diff_part(TS, y, TS, 1619, (27, 58.5, 33.5, 62.5)), 'Ижора и Корела: Столбовский мир 1617 г.'),
    (1632, 1635, lambda y: diff_part(TS, y, TS, 1636, (30, 53, 35, 56)), 'Смоленская война: Смоленск не взят'),
    (1659, 1661, lambda y: diff_part(TS, y, TS, 1662, (21, 51, 31.6, 57)), 'Литва и Белоруссия: оккупация в войне 1654–1667'),
    (1689, 1690, lambda y: diff_part(TS, y, TS, 1691, (115, 46, 145, 57)), 'Приамурье: Нерчинский договор 1689 г.'),
    (1718, 1720, lambda y: diff_part(TS, y, RE, 1721, (19, 59.6, 32, 71)), 'Финляндия: оккупация 1714–1721'),
    (1732, 1734, lambda y: diff_part(RE, y, RE, 1738, (44, 35, 56, 40.2)), 'Гилян, Мазендеран, Астрабад: Рештский договор 1732 г.'),
    (1735, 1737, lambda y: diff_part(RE, y, RE, 1738, (44, 35, 56, 42.6)), 'Баку и Дербент: Гянджинский договор 1735 г.'),
    (1762, 1762, lambda y: diff_part(RE, y, RE, 1763, (12, 52, 23, 56)), 'Восточная Пруссия: оккупация в Семилетней войне'),
    (1769, 1774, lambda y: diff_part(RE, y, RE, 1775, (20, 42, 31.9, 48.6)), 'Молдавия, Валахия, Едисан: оккупация 1769–1774'),
    (1791, 1791, lambda y: diff_part(RE, y, RE, 1790, (20, 42, 32, 48.6)), 'Молдавия и Едисан: Ясский мир — январь 1792 г.'),
    (1792, 1792, lambda y: diff_part(RE, y, RE, 1791, (22, 49, 31, 56.5)), 'Второй раздел Речи Посполитой — 1793 г.'),
    (1796, 1796, lambda y: diff_part(RE, y, RE, 1797, (44, 37, 53, 43.3)), 'Персидский поход 1796 г.: войска отозваны'),
    (1807, 1811, lambda y: diff_part(RE, y, RE, 1806, DANUBE), 'Молдавия, Валахия, Бессарабия: оккупация 1806–1812'),
    (1814, 1814, lambda y: diff_part(RE, y, RE, 1812, (14, 49, 24.5, 55.5)), 'Варшавское герцогство: оккупация 1813–1815'),
    (1828, 1833, lambda y: diff_part(RE, y, RE, 1834, DANUBE), 'Молдавия и Валахия: оккупация 1828–1834'),
    (1803, 1877, lambda y: box(41.4, 41.3, 42.6, 41.83), 'Аджария с Батумом — турецкая до 1878 г.'),
    (1849, 1855, lambda y: diff_part(RE, y, RE, 1848, DANUBE), 'Молдавия и Валахия: оккупация 1848–1851 и 1853–1854'),
    (1864, 1867, lambda y: diff_part(RE, y, RE, 1863, (65.5, 38.5, 68.6, 40.1)), 'Самарканд взят в 1868 г.'),
    (1871, 1884, lambda y: diff_part(RE, y, RE, 1885, (78, 41, 86, 46.5)), 'Илийский край: оккупация 1871–1881'),
    (1873, 1880, lambda y: diff_part(RE, y, RE, 1872, (54.5, 35, 64, 39.4)), 'Ахал-Теке покорён в 1881 г.'),
    (1881, 1883, lambda y: diff_part(RE, y, RE, 1872, (59.5, 35, 64, 38.8)), 'Мерв присоединён в 1884 г.'),
    (1884, 1884, lambda y: diff_part(RE, y, RE, 1872, (61, 35, 63.5, 36.5)), 'Пенде и Кушка — 1885 г.'),
    (1875, 1876, lambda y: diff_part(RE, y, RE, 1877, (145, 43, 157, 51.5)), 'Курилы отошли Японии в 1875 г.'),
    (1877, 1879, lambda y: diff_part(RE, y, RE, 1880, (20, 40, 30.6, 46)), 'Болгария и Румыния: войска в войне 1877–1878'),
    (1900, 1904, lambda y: diff_part(RE, y, RE, 1898, (110, 38.5, 136, 54)), 'Маньчжурия: военная оккупация 1900–1905'),
    (1915, 1916, lambda y: diff_part(RE, y, RE, 1914, (20, 47.4, 27, 51)), 'Галиция: оккупация 1914–1915'),
    (1915, 1917, lambda y: diff_part(RE if y < 1917 else RR, y, RE, 1914, (37, 35, 56, 41.6)),
     'Западная Армения и север Персии: оккупация 1915–1917'),
    (1917, 1917, lambda y: diff_part(RR, y, RE, 1914, DANUBE), 'Румынский фронт'),
    (1921, 1943, lambda y: TUVA, 'Тува: Тувинская народная республика 1921–1944, не входила в СССР'),
    (1940, 1942, lambda y: diff_part(USSR, y, USSR, 1936, (72, 34, 97, 49.6)), 'Синьцзян: советское влияние, не территория СССР'),
    (1920, 1939, lambda y: rec(USSR, 1936).intersection(box(27.55, 56.85, 28.15, 57.4)),
     'Абрене (Пыталово): у Латвии в 1920–1944 гг., граница примерная'),
    (1920, 1939, lambda y: rec(USSR, 1936).intersection(box(27.5, 57.55, 28.05, 58.0)).union(
        rec(USSR, 1936).intersection(box(28.19, 59.1, 28.6, 59.45))),
     'Печоры и Ивангород: у Эстонии в 1920–1944 гг., граница примерная'),
    (1942, 1944, lambda y: diff_part(USSR, y, USSR, 1936, (44, 33, 62, 39.75)), 'Север Ирана: оккупация 1941–1946'),
    (1944, 1944, lambda y: diff_part(USSR, y, USSR, 1941, (20, 43, 30, 49)), 'Румыния: наступление 1944 г., не территория'),
]

ADD = [
    (1392, 1551, lambda y: rec('Nizhny Novgorod', 1394), 'Нижегородское княжество присоединено в 1392 г.'),
    (1478, 1481, lambda y: rec('Novgorod Republic', 1478), 'Новгород присоединён в 1478 г.'),
    (1485, 1486, lambda y: rec('Tver', 1485), 'Тверь присоединена в 1485 г.'),
    (1503, 1506, lambda y: diff_part(GPM, 1507, GPM, 1502, (30, 50, 35.5, 53.5)), 'Чернигово-Северская земля: перемирие 1503 г.'),
    (1510, 1511, lambda y: rec('Pskov Republic', 1510), 'Псков присоединён в 1510 г.'),
    (1514, 1515, lambda y: diff_part(GPM, 1516, GPM, 1513, (30, 53.5, 35, 56)), 'Смоленск взят в 1514 г.'),
    (1563, 1571, lambda y: diff_part(TS, 1572, TS, 1562, (27.5, 55.3, 31, 57)), 'Полоцк взят в 1563 г.'),
    (1654, 1658, lambda y: diff_part(TS, 1662, TS, 1653, (30, 53, 35, 56.5)), 'Смоленск взят в 1654 г.'),
    (1703, 1705, lambda y: diff_part(TS, 1706, TS, 1702, (27, 58.5, 32, 61)), 'Ингрия: Ниеншанц взят в 1703 г.'),
    (1710, 1712, lambda y: diff_part(TS, 1713, TS, 1709, (21, 56, 31, 62)), 'Лифляндия, Эстляндия, Выборг взяты в 1710 г.'),
    (1723, 1731, lambda y: diff_part(RE, 1727, TS, 1720, (44, 35, 56, 42.6)), 'Прикаспийские провинции: Петербургский договор 1723 г.'),
    (1739, 1771, lambda y: diff_part(RE, 1772, RE, 1768, (38.8, 46.8, 40, 47.4)), 'Азов: Белградский мир 1739 г.'),
    (1656, 1669, lambda y: rec('Sloboda Ukraine', 1670), 'Слободская Украина: Харьков основан в 1654–1656 гг.'),
    (1813, 1827, lambda y: diff_part(RE, 1828, RE, 1827, (47.5, 38.3, 49.2, 39.3)), 'Талышское ханство: Гюлистанский мир 1813 г.'),
    (1775, 1782, lambda y: diff_part(RE, 1783, RE, 1774, (31.5, 46, 34, 47.6)), 'Земли между Днепром и Бугом: Кючук-Кайнарджийский мир'),
    (1801, 1802, lambda y: diff_part(RE, 1803, RE, 1800, (43, 40.8, 47, 42.3)), 'Картли-Кахетинское царство: манифест 1801 г.'),
    (1807, 1808, lambda y: diff_part(RE, 1809, RE, 1806, (22, 52.5, 24.5, 54)), 'Белостокская область: Тильзитский мир 1807 г.'),
    (1812, 1813, lambda y: diff_part(RE, 1811, RE, 1812, (22, 52, 40, 57.5)), 'Нашествие Наполеона не меняло границ'),
    (1830, 1833, lambda y: diff_part(RE, 1834, RE, 1830, (14, 49, 24.5, 55)), 'Царство Польское во время восстания оставалось в империи'),
    (1854, 1855, lambda y: diff_part(RE, 1856, RE, 1853, (73, 42, 81, 46)), 'Заилийский край: укрепление Верное 1854 г.'),
    (1875, 1876, lambda y: diff_part(RE, 1877, RE, 1874, (141, 45.8, 145, 50)), 'Весь Сахалин: Петербургский договор 1875 г.'),
    (1878, 1879, lambda y: diff_part(RE, 1880, RE, 1877, (40, 39.5, 44.5, 42)), 'Карс и Батум: Берлинский трактат 1878 г.'),
    (1921, 1921, lambda y: diff_part(USSR, 1922, RSU, 1921, (40, 38.5, 50.5, 43.6)), 'Грузия: советская власть с марта 1921 г.'),
    (1922, 1923, lambda y: diff_part(USSR, 1924, USSR, 1922, (126, 41, 143, 60)), 'Приморье: Владивосток взят 25 октября 1922 г.'),
    (1939, 1939, lambda y: rec(USSR, 1940).intersection(rec('Second Polish Republic', 1939))
     .difference(rec('Republic of Lithuania', 1990)), 'Западная Украина и Западная Белоруссия: ноябрь 1939 г.'),
    (1944, 1944, lambda y: TUVA.union(diff_part(USSR, 1945, USSR, 1944, (28, 68.5, 32, 70.5))),
     'Тува (октябрь 1944) и Печенга (перемирие с Финляндией, сентябрь 1944)'),
]

# СССР 1945–1991: внешняя граница почти не менялась, а Cliopatria включает в СССР
# оккупированные и подконтрольные страны (Польшу, ГДР, Маньчжурию, Чехословакию с 1968,
# части Афганистана). Берём чистую запись 1953–1968 без советского сектора Берлина.
USSR_POSTWAR = rec(USSR, 1953).difference(box(10, 50, 18, 55))
# Довоенная граница 1941 г. без Синьцзяна, Тувы и Ирана — рамка для военных лет.
USSR_1941 = (rec(USSR, 1941).difference(diff_part(USSR, 1941, USSR, 1936, (72, 34, 97, 49.6))).difference(TUVA)
             .difference(diff_part(USSR, 1942, USSR, 1936, (44, 33, 62, 39.75))))


def state_geom(year):
    if 1945 <= year <= 1991:
        g = USSR_POSTWAR
    else:
        g = lineage_raw(year)
        if g is None:
            return None
    for a, b, fn, _ in REMOVE:
        if a <= year <= b:
            g = g.difference(fn(year))
    for a, b, fn, _ in ADD:
        if a <= year <= b:
            g = g.union(fn(year))
    if 1941 <= year <= 1944:
        # Граница — довоенная: оккупированное остаётся территорией СССР и рисуется штриховкой.
        g = g.intersection(USSR_1941.union(TUVA if year == 1944 else EMPTY)
                           .union(rec(USSR, 1945).intersection(box(28, 68.5, 32, 70.5))))
        g = g.union(occupied(year)[0])
    if g.contains(Point(179.5, 67)):
        g = g.union(CHUKOTKA_E)
    if year >= 1924:
        g = g.union(WRANGEL)
    return g


# ---------- Слои поверх ----------
admin1 = {f['properties']['iso_3166_2']: shape(f['geometry']).buffer(0)
          for f in json.load(open(f'{NE}/ne_10m_admin_1_states_provinces.geojson'))['features']
          if f['properties']['iso_3166_2'] in ('UA-43', 'UA-40', 'UA-14', 'UA-09', 'UA-23', 'UA-65')}
CRIMEA = unary_union([admin1['UA-43'], admin1['UA-40']])
CLAIMED_2022 = unary_union([admin1[k] for k in ('UA-14', 'UA-09', 'UA-23', 'UA-65')])


def occupied(year):
    """Территория, занятая противником: законная граница минус то, что держит Cliopatria."""
    if year == 1812:
        return diff_part(RE, 1811, RE, 1812, (22, 52, 40, 57.5)), 'Занято армией Наполеона (июнь–декабрь 1812)'
    if 1915 <= year <= 1917:
        held = rec(RE, 1916) if year < 1917 else rec(RR, 1917)
        occ = rec(RE, 1914).difference(held).intersection(box(18, 49, 30, 58.5))
        return occ, 'Оккупировано Германией и Австро-Венгрией'
    if 1941 <= year <= 1944:
        occ = USSR_1941.difference(rec(USSR, max(year, 1942))).intersection(box(20, 43, 50, 70))
        if year == 1941:
            # Данные отмечают оккупацию с 1942 г.; к концу 1941 г. противник ещё не дошёл
            # до Кавказа и Сталинграда.
            occ = occ.difference(box(37.5, 42, 50, 47.2)).difference(box(41, 47.2, 50, 50.5))
        # Годовые срезы Cliopatria соответствуют разным моментам года (сверено по городам).
        return occ, {
            1941: 'Оккупировано Германией и союзниками (примерно, на конец 1941 г.)',
            1942: 'Оккупировано Германией и союзниками (примерно, на весну 1942 г.; летом и осенью '
                  'противник дошёл до Сталинграда и Кавказа — на карте не показано)',
            1943: 'Оккупировано Германией и союзниками (примерно, на начало 1943 г.)',
            1944: 'Оккупировано Германией и союзниками (примерно, на середину 1944 г.)',
        }[year]
    return None, None


def autonomy(year):
    for a, b, name in UNDER_TSAR[:1]:
        if a <= year <= min(b, 1764):
            return rec(name, year), 'Гетманщина — казачья автономия под властью царя (ликвидирована в 1764 г.)'
    return None, None


# ---------- Сборка сегментов ----------
def segments(fn):
    out, cur = [], None
    for y in range(YEAR_MIN, YEAR_MAX + 1):
        g = fn(y)
        g, label = g if isinstance(g, tuple) else (g, None)
        if g is not None:
            g = g.intersection(REGION)
            if g.is_empty:
                g = None
        key = (set_precision(g, 0.001).wkb if g is not None else None, label)
        if cur and cur['key'] == key:
            cur['to'] = y
        else:
            cur = {'key': key, 'from': y, 'to': y, 'geom': g, 'label': label}
            out.append(cur)
    return [s for s in out if s['geom'] is not None]


features = []
_eq = Transformer.from_crs(4326, 6933, always_xy=True).transform


def km2(g):
    if g.is_empty:
        return 0
    return round(shapely.transform(g, lambda c: list(zip(*_eq(c[:, 0], c[:, 1])))).area / 1e6)


def add(geom, **props):
    if geom.geom_type not in ('Polygon', 'MultiPolygon'):
        geom = unary_union([p for p in getattr(geom, 'geoms', []) if p.geom_type in ('Polygon', 'MultiPolygon')])
    if geom.is_empty:
        return
    features.append({'type': 'Feature', 'geometry': mapping(geom), 'properties': props})


def label_point(g):
    biggest = g if g.geom_type == 'Polygon' else max(g.geoms, key=lambda p: p.area)
    p = biggest.representative_point()
    return [round(p.x, 2), round(p.y, 2)]


prev = None
for s in segments(state_geom):
    g = s['geom'].difference(CRIMEA.buffer(0.02)) if s['from'] >= 2014 else s['geom']
    # Что изменилось к началу сегмента: показывается, пока действует сегмент.
    if prev is not None and prev['to'] == s['from'] - 1:
        for kind, part in (('gain', s['geom'].difference(prev['geom'])), ('loss', prev['geom'].difference(s['geom']))):
            part = unary_union([p for p in getattr(part, 'geoms', [part]) if km2(p) >= 1500]) if not part.is_empty else part
            if not part.is_empty:
                add(part, layer='change', kind=kind, **{'from': s['from'], 'to': s['to']}, km2=km2(part))
    prev = s
    # Подпись меняется внутри сегмента (882→1132): режем по границам подписей.
    for a, b, lab in STATE_LABEL:
        lo, hi = max(a, s['from']), min(b, s['to'])
        if lo <= hi:
            add(g, layer='state', **{'from': lo, 'to': hi}, name=lab, km2=km2(g), lp=label_point(g))

for kind, fn in (('occupied', occupied), ('autonomy', autonomy)):
    for s in segments(fn):
        add(s['geom'], layer='overlay', kind=kind, **{'from': s['from'], 'to': s['to']}, name=s['label'])
add(CRIMEA, layer='overlay', kind='annexed', **{'from': 2014, 'to': YEAR_MAX},
    name='Крым и Севастополь: аннексия 2014 г., не признана ООН (резолюция ГА 68/262)')
add(CLAIMED_2022, layer='overlay', kind='claimed', **{'from': 2022, 'to': YEAR_MAX},
    name='Донецкая, Луганская, Запорожская, Херсонская области: аннексия объявлена 30.09.2022, '
         'не признана ООН (резолюция ГА ES-11/4); Россия контролирует их частично')

RUS_SET = set(RUS_PRINCIPALITIES)
for name, rows in recs.items():
    if name in EXCLUDE_CONTEXT or name.startswith('('):
        continue
    for a, b, f in rows:
        if b < YEAR_MIN or f['properties']['Type'] != 'POLITY':
            continue
        g = shape(f['geometry']).buffer(0)
        if not g.intersects(REGION):
            continue
        g = g.intersection(REGION)
        if not g.is_empty:
            add(g, layer='context', **{'from': max(a, YEAR_MIN), 'to': YEAR_MAX if b == DATA_MAX else b},
                name=name, rus=name in RUS_SET, lp=label_point(g), km2=km2(g))

json.dump({'type': 'FeatureCollection', 'features': features}, open(f'{OUT}/raw.geojson', 'w'))
# Список исправлений — для раздела «О карте» на сайте.
json.dump({'remove': [[a, b, note] for a, b, _, note in REMOVE], 'add': [[a, b, note] for a, b, _, note in ADD]},
          open(f'{OUT}/corrections.json', 'w'), ensure_ascii=False)
by_layer = defaultdict(int)
for f in features:
    by_layer[f['properties']['layer']] += 1
print(dict(by_layer))
