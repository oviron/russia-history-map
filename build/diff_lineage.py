"""Диагностика: что прибавилось и убыло у российского государства между записями Cliopatria."""
import json, sys
from shapely.geometry import shape
from shapely.ops import transform
from pyproj import Transformer

LINEAGE = ["Rus'", "Kievan Rus'", "Grand Principality of Moscow", "Tsardom of Russia", "Russian Empire",
           "Russian Republic", "Republics of the Soviet Union", "Union of Soviet Socialist Republics", "Russian Federation"]
eq = Transformer.from_crs(4326, 6933, always_xy=True).transform

recs = []
for f in json.load(open(sys.argv[1]))['features']:
    p = f['properties']
    if p['Name'] in LINEAGE and not (p['Name'] == "Kievan Rus'" and p['FromYear'] >= 1236):
        recs.append((p['FromYear'], p['ToYear'], p['Name'], shape(f['geometry']).buffer(0)))
recs.sort(key=lambda r: r[0])
for (a0, a1, an, ag), (b0, b1, bn, bg) in zip(recs, recs[1:]):
    def chunks(g):
        g = transform(eq, g) if not g.is_empty else g
        out = []
        for part in getattr(g, 'geoms', [g]):
            km = part.area / 1e6
            if km > 3000:
                c = transform(Transformer.from_crs(6933, 4326, always_xy=True).transform, part.centroid)
                out.append(f"{km/1000:.0f}k@{c.x:.0f},{c.y:.0f}")
        return sorted(out, key=lambda s: -float(s.split('k')[0]))[:5]
    gain, loss = chunks(bg.difference(ag)), chunks(ag.difference(bg))
    if gain or loss:
        print(f"{a0}-{a1}→{b0}: +{' '.join(gain)}  −{' '.join(loss)}")
