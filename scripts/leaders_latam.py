"""Registry for the Latin American presidents added in v1.1.0.

These come from a single source file, ``entiredatasetCH1.csv``, which is already
in the same shape as the main collection files and carries all four engagement
metrics. Each leader is keyed by the ``short_name`` used in that file.

Bolsonaro and Lopez Obrador appear in that file too but are deliberately absent
here: both are already in the dataset from the original collection with wider
coverage and full timestamps, and the file's Bolsonaro rows carry date-only
timestamps that would not deduplicate against them. See CHANGELOG v1.1.0.

Handles were taken from the collection's own timeline files where those exist,
and otherwise verified against the accounts themselves. ``None`` means the
handle could not be confirmed -- it is left empty rather than guessed.

``populist`` records the classification carried in the source file's
``type_of_leader`` column. It is the dataset author's own research coding, not
an external standard.
"""

SOURCE_FILE = "entiredatasetCH1.csv"

LATAM_LEADERS = [
    dict(short_name="SANTOS", leader_id="santos", name="Juan Manuel Santos",
         handle="JuanManSantos", country="Colombia", iso3="COL",
         office="President", populist=False),
    dict(short_name="EVO", leader_id="morales_evo", name="Evo Morales",
         handle="evoespueblo", country="Bolivia", iso3="BOL",
         office="President", populist=True),
    dict(short_name="CORREA", leader_id="correa", name="Rafael Correa",
         handle="MashiRafael", country="Ecuador", iso3="ECU",
         office="President", populist=True),
    dict(short_name="MADURO", leader_id="maduro", name="Nicolás Maduro",
         handle="NicolasMaduro", country="Venezuela", iso3="VEN",
         office="President", populist=True),
    dict(short_name="SOLIS", leader_id="solis", name="Luis Guillermo Solís",
         handle="luisguillermosr", country="Costa Rica", iso3="CRI",
         office="President", populist=False),
    dict(short_name="CRISTINA", leader_id="fernandez_cristina",
         name="Cristina Fernández de Kirchner", handle="CFKArgentina",
         country="Argentina", iso3="ARG", office="President", populist=False),
    dict(short_name="Varela", leader_id="varela", name="Juan Carlos Varela",
         handle="JC_Varela", country="Panama", iso3="PAN",
         office="President", populist=False),
    dict(short_name="TEMER", leader_id="temer", name="Michel Temer",
         handle="MichelTemer", country="Brazil", iso3="BRA",
         office="President", populist=False),
    dict(short_name="DILMA", leader_id="rousseff", name="Dilma Rousseff",
         handle="dilmabr", country="Brazil", iso3="BRA",
         office="President", populist=False),
    dict(short_name="EPN", leader_id="pena_nieto", name="Enrique Peña Nieto",
         handle="EPN", country="Mexico", iso3="MEX",
         office="President", populist=False),
    dict(short_name="MORENO", leader_id="moreno", name="Lenín Moreno",
         handle="Lenin", country="Ecuador", iso3="ECU",
         office="President", populist=False),
    dict(short_name="MACRI", leader_id="macri", name="Mauricio Macri",
         handle="mauriciomacri", country="Argentina", iso3="ARG",
         office="President", populist=False),
    dict(short_name="CHINCHILLA", leader_id="chinchilla", name="Laura Chinchilla",
         handle="Laura_Ch", country="Costa Rica", iso3="CRI",
         office="President", populist=False),
    dict(short_name="OPEREZ", leader_id="perez_molina", name="Otto Pérez Molina",
         handle="ottoperezmolina", country="Guatemala", iso3="GTM",
         office="President", populist=False),
    dict(short_name="CALDERON", leader_id="calderon", name="Felipe Calderón",
         handle="FelipeCalderon", country="Mexico", iso3="MEX",
         office="President", populist=False),
    dict(short_name="PINERA", leader_id="pinera", name="Sebastián Piñera",
         handle="sebastianpinera", country="Chile", iso3="CHL",
         office="President", populist=False),
    dict(short_name="CARTES", leader_id="cartes", name="Horacio Cartes",
         handle="Horacio_Cartes", country="Paraguay", iso3="PRY",
         office="President", populist=False),
    dict(short_name="CHAVEZ", leader_id="chavez", name="Hugo Chávez",
         handle="chavezcandanga", country="Venezuela", iso3="VEN",
         office="President", populist=True),
    dict(short_name="KUCZYNSKI", leader_id="kuczynski",
         name="Pedro Pablo Kuczynski", handle="ppkamigo",
         country="Peru", iso3="PER", office="President", populist=False),
    dict(short_name="PLOBO", leader_id="lobo", name="Porfirio Lobo",
         handle="PEPE_LOBO", country="Honduras", iso3="HND",
         office="President", populist=False),
    dict(short_name="BACHELET", leader_id="bachelet", name="Michelle Bachelet",
         handle="mbachelet", country="Chile", iso3="CHL",
         office="President", populist=False),
    # Handle unverified: the only accounts found were other platforms, and the
    # account has been reported compromised. Left empty rather than guessed.
    dict(short_name="JMORALES", leader_id="morales_jimmy", name="Jimmy Morales",
         handle=None, country="Guatemala", iso3="GTM",
         office="President", populist=False),
]

#: Present in the source file but intentionally not imported -- already in the
#: dataset from the original collection, with wider coverage.
SKIPPED_SHORT_NAMES = {"BOLSONARO": "bolsonaro", "AMLO": "lopez_obrador"}

assert len({l["leader_id"] for l in LATAM_LEADERS}) == len(LATAM_LEADERS) == 22
